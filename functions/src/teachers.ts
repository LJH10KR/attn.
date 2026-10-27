import * as admin from "firebase-admin";
import { FieldValue, Timestamp, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { reconcileUserActivationMirror } from "./user-activation-mirror";
import { assertPermission, type AcademyActor } from "./lib/academy-access";
import { normalizePermissionList } from "./lib/permissions";
import { staffAccountChangeViolation } from "./lib/role-policy";
import {
  deleteAttnLoginIndexForMember,
  deleteMemberLoginSecrets,
  purgeUserFirestoreData,
  stripTeacherFromStudents,
} from "./lib/firestore-cleanup";

/**
 * 직원 계정 — 활성 상태 조회, 담당 학생 목록, 승인(활성)·비활성·삭제.
 * 계정 만들기는 `staff-invites.ts`(초대 링크·직접 만들어 주기), 인사 정보는 `staff.ts`.
 */

/** pending_setup: 직접 만들어 준 계정(최초 로그인 전) · pending_registration: 초대 링크 가입 후 승인 대기 */
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

const enforceAppCheckOnTeacherState = process.env.ENFORCE_APP_CHECK === "1";

export const getTeacherActivationState = onCall(
  { cors: true, enforceAppCheck: enforceAppCheckOnTeacherState },
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

/**
 * 활성 선생님 전담 학생 목록 — 클라이언트 Firestore list + 보안 규칙 OR 조합이
 * 에뮬/일부 환경에서 evaluation error를 내는 경우가 있어 Admin 조회로 통일합니다.
 */
export const listTeacherAssignedStudents = onCall(
  { cors: true, enforceAppCheck: enforceAppCheckOnTeacherState },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
    }
    const uid = request.auth.uid;
    const academyId =
      typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
    if (!academyId) {
      throw new HttpsError("invalid-argument", "학원 ID가 필요합니다.");
    }

    const db = admin.firestore();
    const teacherRef = db.doc(`academies/${academyId}/staff/${uid}`);
    const col = db.collection(`academies/${academyId}/students`);

    const [teacherSnap, byArrSnap, byLegacySnap] = await Promise.all([
      teacherRef.get(),
      col.where("assignedTeacherUids", "array-contains", uid).get(),
      col.where("assignedTeacherUid", "==", uid).get(),
    ]);
    if (!teacherSnap.exists || teacherSnap.get("status") !== "active") {
      throw new HttpsError("permission-denied", "이 학원의 활성 선생님만 학생 목록을 조회할 수 있습니다.");
    }

    const byId = new Map<string, QueryDocumentSnapshot>();
    for (const d of byArrSnap.docs) {
      byId.set(d.id, d);
    }
    for (const d of byLegacySnap.docs) {
      byId.set(d.id, d);
    }

    const students = [...byId.values()].map((d) => {
      const data = d.data();
      const createdAt = data.createdAt as Timestamp | undefined;
      const createdAtMillis =
        createdAt && typeof createdAt.toMillis === "function" ? createdAt.toMillis() : null;
      const rawUids = data.assignedTeacherUids;
      const assignedTeacherUids =
        Array.isArray(rawUids) && rawUids.every((x: unknown) => typeof x === "string")
          ? (rawUids as string[]).filter((x) => x.length > 0)
          : [];
      const legacyUid = data.assignedTeacherUid;
      return {
        id: d.id,
        parentUserId: typeof data.parentUserId === "string" ? data.parentUserId : "",
        name: typeof data.name === "string" ? data.name : "",
        age: typeof data.age === "number" && Number.isFinite(data.age) ? Math.floor(data.age) : 0,
        phone: typeof data.phone === "string" ? data.phone : "",
        emergencyContact: typeof data.emergencyContact === "string" ? data.emergencyContact : "",
        assignedTeacherUids,
        assignedTeacherUid:
          typeof legacyUid === "string" && legacyUid.length > 0 ? legacyUid : null,
        createdAtMillis,
      };
    });

    return { ok: true as const, students };
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

  await admin.auth().setCustomUserClaims(teacherAuthUid, {
    role: "teacher",
    academyId,
    membershipStatus: "active",
  });

  await admin.auth().updateUser(teacherAuthUid, { disabled: false });

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

  await stripTeacherFromStudents(db, academyId, authUid);
  await deleteMemberLoginSecrets(db, academyId, "teacher", teacherId);
  await deleteAttnLoginIndexForMember(db, data, authUid);
  await ref.delete();

  // 등록 대기(초대 링크 가입 거절)·임시 비밀번호 발급 상태 포함, 계정이 있으면 Auth 사용자도 삭제
  try {
    await admin.auth().deleteUser(authUid);
  } catch (e) {
    logger.warn("deleteTeacherInvite: auth delete skipped", { authUid, e });
  }
  await purgeUserFirestoreData(db, authUid);

  return { ok: true };
});
