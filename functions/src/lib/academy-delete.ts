import * as admin from "firebase-admin";
import { FieldPath } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {
  academyDeletionRef,
  markAcademyDeletion,
  readDeletionMemberUids,
} from "./academy-deletion-state";
import {
  releaseAuthIfUnused,
  releaseDeletedAcademyMembers,
  type AuthReleaseResult,
} from "./admin-user-cleanup";
import { deleteAttnLoginIndexForMember, deleteQueryDocs } from "./firestore-cleanup";
import { deleteAcademySignupLinks } from "./signup-links";

/**
 * 학원 전체 삭제(2-N) — 원장(`deleteOwnerAcademy`)·관리자(`adminDeleteAcademyCascade`)·seed(`deleteSeedBatch`)·
 * 잔여 정리(`adminOrphanData`)가 같은 순서로 지운다. 결제 기록(`payments`)도 지운다(N8).
 *
 * 순서(어느 단계에서 멈춰도 같은 호출로 이어서 끝나게 — 학원 문서는 마지막):
 * 1. 서버 전용 삭제 표시 `_academyDeletions/{id}` + 멤버 uid(서버가 읽은 값만, B1) — 이 뒤로 학원 아래 쓰기는 거부·건너뜀(B2)
 * 2. 최상위 문서: 멤버 로그인 색인 · 가입 링크 · 푸시 전달 · 푸시 횟수 제한 — 멤버 문서를 지우기 전에(F4)
 * 3. 학원 아래 모든 하위 컬렉션 `recursiveDelete`(★7 — 이름 목록이 아니라 실제 있는 것 전부)
 * 4. 멤버 계정 — 다른 쓰임이 없으면 Auth 삭제(★4)
 * 5. 학원 문서 삭제 → 한 번 더 쓸기(그 사이 생긴 문서)
 * 6. 원장 계정 — 원장이 지운 경우 그대로(★3), 관리자·seed는 다른 쓰임이 없을 때만
 * 7. 삭제 표시 삭제
 */

export type AcademyDeleteOptions = {
  /** keep: 원장 본인이 지움(원장 계정 유지) / delete_if_unused: 관리자·seed·잔여 정리 */
  ownerAccount: "keep" | "delete_if_unused";
  context: string;
  requestedBy: string;
  /** 학원 문서가 이미 없을 때(잔여 정리·이어서 지우기) 쓸 원장 uid — 보통은 학원 문서·삭제 표시에서 읽음 */
  ownerUidHint?: string;
};

export type AcademyDeleteResult = {
  memberAccounts: Record<string, AuthReleaseResult>;
  ownerAccount: AuthReleaseResult | "kept_owner_path" | "none";
};

type MemberRow = { authUid: string | null; data: FirebaseFirestore.DocumentData };

function memberRow(d: admin.firestore.QueryDocumentSnapshot): MemberRow {
  const data = d.data();
  const au = data.authUid;
  // 계정 없는 직원(인사 기록)·초청 전 학부모(임시 ID)는 Auth가 없다
  if (typeof au === "string" && au) return { authUid: au, data };
  return { authUid: data.status === "no_account" || au === null ? null : d.id, data };
}

/** 출결 푸시 횟수 제한 문서(`_pushRateLimits`) — ID가 이 학원 접두로 시작하는 것(ID만 든 문서) */
const PUSH_RATE_LIMIT_PREFIXES = ["attendance_", "class_attendance_", "pin_setup_reminder_"] as const;

async function deletePushRateLimits(db: admin.firestore.Firestore, academyId: string): Promise<void> {
  for (const p of PUSH_RATE_LIMIT_PREFIXES) {
    const prefix = `${p}${academyId}_`;
    await deleteQueryDocs(
      db,
      db
        .collection("_pushRateLimits")
        .where(FieldPath.documentId(), ">=", prefix)
        .where(FieldPath.documentId(), "<", `${prefix}\uf8ff`),
    );
  }
}

export async function deleteAcademyCompletely(
  db: admin.firestore.Firestore,
  academyId: string,
  opts: AcademyDeleteOptions,
): Promise<AcademyDeleteResult> {
  const academyRef = db.doc(`academies/${academyId}`);
  const [academySnap, deletionSnap] = await db.getAll(academyRef, academyDeletionRef(db, academyId));
  const ownerUid =
    (typeof academySnap.get("ownerUid") === "string" ? (academySnap.get("ownerUid") as string) : "") ||
    (typeof deletionSnap.get("ownerUid") === "string" ? (deletionSnap.get("ownerUid") as string) : "") ||
    opts.ownerUidHint ||
    "";

  // 1. 삭제 표시 + 지금 멤버 uid
  const [staffSnap, parentsSnap] = await Promise.all([
    academyRef.collection("staff").get(),
    academyRef.collection("parents").get(),
  ]);
  const members = [...staffSnap.docs, ...parentsSnap.docs].map(memberRow);
  const currentUids = [...new Set(members.flatMap((m) => (m.authUid ? [m.authUid] : [])))];
  await markAcademyDeletion(db, academyId, {
    requestedBy: opts.requestedBy,
    context: opts.context,
    ownerUid,
    memberAuthUids: currentUids,
  });

  // 2. 최상위 문서(멤버 문서를 지우기 전에)
  for (const m of members) {
    if (m.authUid) await deleteAttnLoginIndexForMember(db, m.data, m.authUid);
  }
  await deleteAcademySignupLinks(db, academyId);
  await deleteQueryDocs(db, db.collection("signupLinks").where("academyId", "==", academyId));
  await deleteQueryDocs(db, db.collection("_pushDeliveries").where("academyId", "==", academyId));
  await deletePushRateLimits(db, academyId);

  // 3. 하위 컬렉션 전부(결제 기록·meta 포함)
  for (const col of await academyRef.listCollections()) {
    await db.recursiveDelete(col);
  }

  // 4. 멤버 계정(이 학원 문서는 이미 없어 다른 학원 소속만 걸림)
  const recordedUids = await readDeletionMemberUids(db, academyId);
  const memberAccounts = await releaseDeletedAcademyMembers(db, {
    memberAuthUids: [...recordedUids, ...currentUids],
    ownerUid,
    context: opts.context,
  });

  // 5. 학원 문서 마지막 + 한 번 더 쓸기
  await academyRef.delete();
  await db.recursiveDelete(academyRef);

  // 6. 원장 계정
  let ownerAccount: AcademyDeleteResult["ownerAccount"] = "none";
  if (ownerUid) {
    ownerAccount =
      opts.ownerAccount === "keep"
        ? "kept_owner_path"
        : await releaseAuthIfUnused(db, ownerUid, opts.context, { ignoreOwnerRole: true });
  }

  // 7. 삭제 표시
  await academyDeletionRef(db, academyId).delete();
  logger.info("deleteAcademyCompletely done", {
    academyId,
    context: opts.context,
    members: Object.keys(memberAccounts).length,
    ownerAccount,
  });
  return { memberAccounts, ownerAccount };
}
