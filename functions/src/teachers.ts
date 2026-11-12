import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { reconcileUserActivationMirror } from "./user-activation-mirror";
import { finishStaffActivation } from "./lib/staff-account";
import { assertPermission, type AcademyActor } from "./lib/academy-access";
import { normalizePermissionList } from "./lib/permissions";
import { staffAccountChangeViolation } from "./lib/role-policy";
import { removeStaffMembership } from "./lib/account-membership";
import { releaseAuthIfUnused } from "./lib/admin-user-cleanup";

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

  // 써 오던 계정(사용 중·비활성)은 계정만 지우고 인사 기록 유지 — 초대 취소·가입 거절(첫 로그인 전·승인 대기)과 게스트는 전체 삭제.
  // `deleteHrRecord`(2-L S1, 삭제 창 "인사 기록도 함께 지우기")면 써 오던 계정도 인사 기록까지 지운다(권한은 같음).
  // 본인 탈퇴(2-N)도 같은 정리(`removeStaffMembership`)를 쓴다.
  const removal = await removeStaffMembership(db, academyId, teacherId, callerUid, {
    deleteHrRecord: request.data?.deleteHrRecord === true,
  });
  if (removal.result === "missing") {
    throw new HttpsError("not-found", "선생님 정보를 찾을 수 없습니다.");
  }
  // 2-N ★5 — 다른 학원 소속·소유 학원·원장 계정이면 Auth는 남긴다(이 학원 소속만 정리)
  await releaseAuthIfUnused(db, removal.authUid, "deleteTeacherInvite");

  return { ok: true as const, keptStaffId: removal.keptStaffId };
});
