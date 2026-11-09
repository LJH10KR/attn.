import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { reconcileUserActivationMirror } from "./user-activation-mirror";
import { detachStaffAccount, finishStaffActivation } from "./lib/staff-account";
import { assertPermission, type AcademyActor } from "./lib/academy-access";
import { normalizePermissionList } from "./lib/permissions";
import { staffAccountChangeViolation } from "./lib/role-policy";
import { stripTeacherFromClasses } from "./lib/class-teachers";
import {
  deleteAttnLoginIndexForMember,
  deleteMemberLoginSecrets,
  purgeUserFirestoreData,
} from "./lib/firestore-cleanup";

/**
 * 직원 계정 — 활성 상태 조회, 승인(활성)·비활성·삭제.
 * 담당 학생 목록은 선생님 화면이 클라이언트 쿼리(`students where teacherUids array-contains 본인`, 규칙 허용)로 읽는다.
 * 계정 삭제는 사용 중·비활성이면 인사 기록을 계정 없는 직원으로 남기고, 첫 로그인 전·승인 대기·게스트는 전체 삭제.
 * 계정 만들기는 `staff-signup.ts`(공용 가입 링크·합쳐 승인)·`staff-accounts.ts`(직접 만들어 주기), 인사 정보는 `staff.ts`.
 */

/** pending_setup: 직접 만들어 준 계정(최초 로그인 전) · pending_registration: 공용 가입 링크 가입 후 승인 대기 */
type TeacherStatus =
  | "no_account"
  | "pending_setup"
  | "pending_registration"
  | "active"
  | "inactive";

/** 직원은 본인·더 넓은 권한의 직원 계정을 바꿀 수 없음(`role-policy.ts`) */
function assertStaffAccountChangeAllowed(
  actor: AcademyActor,
  staffSnap: admin.firestore.DocumentSnapshot,
): void {
  const violation = staffAccountChangeViolation(actor, {
    staffId: staffSnap.id,
    staffCurrentPermissions: normalizePermissionList(staffSnap.get("permissions")),
  });
  if (violation) {
    throw new HttpsError("permission-denied", violation);
  }
}

/** 직원 계정 비활성화 — 로그인 차단(Auth disabled)과 클레임 정리. 선생님 비활성·퇴사 처리에서 공용 */
export async function deactivateStaffAccount(
  db: admin.firestore.Firestore,
  academyId: string,
  authUid: string,
): Promise<void> {
  await db.doc(`academies/${academyId}/staff/${authUid}`).update({
    status: "inactive" satisfies TeacherStatus,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await admin.auth().setCustomUserClaims(authUid, {
    role: "teacher",
    academyId,
    teacherDisabled: true,
  });

  await admin.auth().updateUser(authUid, { disabled: true });
}

export const getTeacherActivationState = onCall(
  { cors: true },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
    }
    const { uid } = request.auth;

    const db = admin.firestore();
    const { teacher } = await reconcileUserActivationMirror(db, uid, "reconcile");

    return {
      ok: true,
      anyActive: teacher.anyActive,
      primaryStatus: teacher.primaryStatus as TeacherStatus | null,
      primaryAcademyId: teacher.primaryAcademyId,
    };
  },
);

export const activateTeacher = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid: callerUid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const teacherAuthUid =
    typeof request.data?.teacherAuthUid === "string" ? request.data.teacherAuthUid.trim() : "";
  if (!academyId || !teacherAuthUid) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  const actor = await assertPermission(db, academyId, callerUid, token, "settings.members");

  const ref = db.doc(`academies/${academyId}/staff/${teacherAuthUid}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "선생님 정보를 찾을 수 없습니다.");
  }
  assertStaffAccountChangeAllowed(actor, snap);
  const st = snap.get("status") as TeacherStatus;
  if (st !== "pending_registration" && st !== "inactive") {
    throw new HttpsError("failed-precondition", "활성화할 수 있는 상태가 아닙니다.");
  }
  if (snap.get("employmentStatus") === "resigned") {
    throw new HttpsError(
      "failed-precondition",
      "퇴사 처리된 직원입니다. 직원 관리에서 재직 상태로 바꾼 뒤 활성화해 주세요.",
    );
  }

  await ref.update({
    status: "active" satisfies TeacherStatus,
    activatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await finishStaffActivation(academyId, teacherAuthUid);

  return { ok: true };
});

export const deactivateTeacher = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid: callerUid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const teacherAuthUid =
    typeof request.data?.teacherAuthUid === "string" ? request.data.teacherAuthUid.trim() : "";
  if (!academyId || !teacherAuthUid) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  const actor = await assertPermission(db, academyId, callerUid, token, "settings.members");

  const ref = db.doc(`academies/${academyId}/staff/${teacherAuthUid}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "선생님 정보를 찾을 수 없습니다.");
  }
  assertStaffAccountChangeAllowed(actor, snap);
  if (snap.get("status") !== "active") {
    throw new HttpsError("failed-precondition", "활성 상태의 선생님만 비활성화할 수 있습니다.");
  }

  await deactivateStaffAccount(db, academyId, teacherAuthUid);

  return { ok: true };
});

export const deleteTeacherInvite = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid: callerUid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const teacherId =
    typeof request.data?.teacherId === "string" ? request.data.teacherId.trim() : "";
  if (!academyId || !teacherId) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  const actor = await assertPermission(db, academyId, callerUid, token, "settings.members");

  const ref = db.doc(`academies/${academyId}/staff/${teacherId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "선생님 정보를 찾을 수 없습니다.");
  }
  assertStaffAccountChangeAllowed(actor, snap);
  const st = snap.get("status") as TeacherStatus;
  if (st === "no_account") {
    throw new HttpsError("failed-precondition", "계정이 없는 직원은 직원 관리에서 삭제해 주세요.");
  }

  const authUid = (snap.get("authUid") as string | undefined) || teacherId;
  const data = snap.data() ?? {};
  // 써 오던 계정(사용 중·비활성)은 계정만 지우고 인사 기록 유지 — 초대 취소·가입 거절(첫 로그인 전·승인 대기)과 게스트는 전체 삭제
  const keepStaffRecord = (st === "active" || st === "inactive") && snap.get("isGuest") !== true;

  await deleteMemberLoginSecrets(db, academyId, "teacher", teacherId);
  await deleteAttnLoginIndexForMember(db, data, authUid);
  const keptStaffId = keepStaffRecord ? await detachStaffAccount(db, academyId, snap) : null;
  if (!keepStaffRecord) {
    await ref.delete();
  }
  // staff 문서를 분리·삭제한 뒤 반에서 뺀다 — 그 사이 저장된 반도 새 uid 검사(D6)에서 막히므로 지운 uid가 남지 않음
  await stripTeacherFromClasses(db, academyId, authUid, callerUid);

  try {
    await admin.auth().deleteUser(authUid);
  } catch (e) {
    logger.warn("deleteTeacherInvite: auth delete skipped", { authUid, e });
  }
  await purgeUserFirestoreData(db, authUid);

  return { ok: true as const, keptStaffId };
});
