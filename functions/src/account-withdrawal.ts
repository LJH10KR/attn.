import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { removeParentMembership, removeStaffMembership, keepsStaffHrRecord } from "./lib/account-membership";
import { academyIdOfMemberPath, accountMemberships, ownedAcademyIds } from "./lib/account-use";
import {
  WITHDRAWAL_BLOCK_MESSAGE,
  WITHDRAWAL_MAX_ROUNDS,
  withdrawalBlock,
  withdrawnBellId,
} from "./lib/account-withdrawal";
import { writeInfoBell } from "./lib/admin-inbox-info";
import { deleteAuthUserIfExists } from "./lib/admin-user-cleanup";
import { stripTeacherFromClasses } from "./lib/class-teachers";
import { purgeUserFirestoreData } from "./lib/firestore-cleanup";
import { hasLoginSecret } from "./lib/password-hash";
import { assertRecentAuth } from "./lib/recent-auth";

/**
 * 본인 회원 탈퇴(2-N) — 계정 단위(N1): 이 로그인 계정의 모든 학원 소속(학부모·직원)을 학원이 지우는 경우와 같게 정리하고(N11)
 * 사용자 데이터·Auth를 지운다. 관리자 계정·소유 학원이 있는 원장은 거부(N5). 최근 인증 5분(★1).
 * 다시 불러도 이어서 끝난다 — 매번 남은 소속을 다시 찾고, Auth 삭제가 마지막 필수 단계.
 * 진행 기록 `_accountWithdrawals/{uid}`(서버 전용): 직원으로 있던 학원 — 계정 문서가 먼저 지워진 뒤 반 정리가 멈춰도 다시 할 수 있게.
 */

function readUid(request: { auth?: { uid: string } | null }): string {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  return uid;
}

function isAdminToken(token: Record<string, unknown> | undefined): boolean {
  return token?.admin === true;
}

function progressRef(db: admin.firestore.Firestore, uid: string) {
  return db.doc(`_accountWithdrawals/${uid}`);
}

function displayNameOf(d: admin.firestore.DocumentSnapshot): string {
  const n = d.get("displayName");
  return typeof n === "string" && n.trim() ? n.trim() : "이름 미입력";
}

async function academyNames(db: admin.firestore.Firestore, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const snaps = await db.getAll(...unique.map((id) => db.doc(`academies/${id}`)));
  return new Map(
    snaps.filter((s) => s.exists).map((s) => [s.id, typeof s.get("name") === "string" ? (s.get("name") as string) : ""]),
  );
}

/** 탈퇴 화면 정보 — 막힘, 소유 학원, 함께 끝나는 소속, 본인 재확인 방법 */
export const getAccountWithdrawalInfo = onCall(async (request) => {
  const uid = readUid(request);
  const token = request.auth?.token as Record<string, unknown> | undefined;
  const db = admin.firestore();

  const [owned, memberships, user] = await Promise.all([
    ownedAcademyIds(db, uid),
    accountMemberships(db, uid),
    admin.auth().getUser(uid),
  ]);
  const memberRows = [
    ...memberships.staff.map((d) => ({ role: "teacher" as const, academyId: academyIdOfMemberPath(d.ref.path, "staff")! })),
    ...memberships.parents.map((d) => ({ role: "parent" as const, academyId: academyIdOfMemberPath(d.ref.path, "parents")! })),
  ];
  const names = await academyNames(db, [...owned, ...memberRows.map((m) => m.academyId)]);

  // 로그인 ID 비밀번호 재확인(`reauthenticateMember`)은 클레임 학원의 계정 문서 비밀번호로 확인
  let memberPassword = false;
  const claimRole = token?.role === "teacher" ? "staff" : token?.role === "parent" ? "parents" : null;
  const claimAcademy = typeof token?.academyId === "string" ? token.academyId : "";
  if (claimRole && claimAcademy && !claimAcademy.includes("/")) {
    const secret = await db.doc(`academies/${claimAcademy}/${claimRole}/${uid}/secrets/login`).get();
    memberPassword = hasLoginSecret(secret.data());
  }
  const providers = user.providerData.map((p) => p.providerId);

  return {
    ok: true as const,
    blocked: withdrawalBlock(isAdminToken(token), owned.length),
    ownedAcademies: owned.map((academyId) => ({ academyId, name: names.get(academyId) || "학원" })),
    memberships: memberRows
      .filter((m) => names.has(m.academyId))
      .map((m) => ({ role: m.role, academyName: names.get(m.academyId) || "학원" })),
    reauth: {
      memberPassword,
      ownerPassword: providers.includes("password"),
      google: providers.includes("google.com"),
    },
  };
});

/** 탈퇴 실행 */
export const withdrawAccount = onCall({ timeoutSeconds: 120 }, async (request) => {
  const uid = readUid(request);
  const token = request.auth?.token as Record<string, unknown> | undefined;
  const db = admin.firestore();

  const block = withdrawalBlock(isAdminToken(token), (await ownedAcademyIds(db, uid, 1)).length);
  if (block) {
    throw new HttpsError("failed-precondition", WITHDRAWAL_BLOCK_MESSAGE[block], { reason: block });
  }
  await assertRecentAuth(request);

  // 1. 소속마다 — 원장 벨(지우기 전에, 결정 ID) → 학원이 지우는 경우와 같은 정리
  let teacherCount = 0;
  let parentCount = 0;
  for (let round = 0; round < WITHDRAWAL_MAX_ROUNDS; round += 1) {
    const { staff, parents } = await accountMemberships(db, uid);
    if (staff.length === 0 && parents.length === 0) break;
    for (const d of staff) {
      const academyId = academyIdOfMemberPath(d.ref.path, "staff")!;
      await progressRef(db, uid).set(
        { uid, startedAt: FieldValue.serverTimestamp(), staffAcademyIds: FieldValue.arrayUnion(academyId) },
        { merge: true },
      );
      await writeInfoBell(db, academyId, withdrawnBellId("teacher", uid), {
        kind: "member_withdrawn",
        entityType: "teacher",
        entityId: uid,
        displayName: displayNameOf(d),
        variant: keepsStaffHrRecord(d.get("status"), d.get("isGuest"), false) ? "kept_hr_record" : "removed",
      });
      await removeStaffMembership(db, academyId, d.id, uid, { deleteHrRecord: false });
      teacherCount += 1;
    }
    for (const d of parents) {
      const academyId = academyIdOfMemberPath(d.ref.path, "parents")!;
      await writeInfoBell(db, academyId, withdrawnBellId("parent", uid), {
        kind: "member_withdrawn",
        entityType: "parent",
        entityId: uid,
        displayName: displayNameOf(d),
      });
      await removeParentMembership(db, academyId, d.id);
      parentCount += 1;
    }
  }
  const left = await accountMemberships(db, uid);
  if (left.staff.length > 0 || left.parents.length > 0) {
    throw new HttpsError("aborted", "탈퇴를 끝내지 못했어요. 다시 시도해 주세요.", { reason: "partial" });
  }

  // 2. 직원으로 있던 학원의 반 담당 정리(계정 문서가 먼저 지워진 채 멈췄던 경우까지 — 여러 번 해도 같음)
  const staffAcademyIds = (await progressRef(db, uid).get()).get("staffAcademyIds");
  for (const academyId of Array.isArray(staffAcademyIds) ? staffAcademyIds : []) {
    if (typeof academyId === "string" && academyId && !academyId.includes("/")) {
      await stripTeacherFromClasses(db, academyId, uid, uid);
    }
  }

  // 3. 사용자 데이터 → 소유 학원 다시 확인(다른 기기에서 그 사이 만든 학원) → Auth 삭제 → 한 번 더 정리
  await purgeUserFirestoreData(db, uid);
  if ((await ownedAcademyIds(db, uid, 1)).length > 0) {
    throw new HttpsError("failed-precondition", WITHDRAWAL_BLOCK_MESSAGE.owns_academies, { reason: "owns_academies" });
  }
  await deleteAuthUserIfExists(uid);
  await purgeUserFirestoreData(db, uid).catch((e) => logger.warn("withdrawAccount: 마지막 정리 실패(무시)", { e }));

  logger.info("withdrawAccount done", { teacherCount, parentCount });
  return { ok: true as const };
});
