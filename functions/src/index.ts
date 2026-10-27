import {setGlobalOptions} from "firebase-functions";
import {onCall, HttpsError} from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

/**
 * `createCustomToken`용 IAM 서명 주체.
 * Gen2에서는 메타데이터 기본 SA가 compute 기본 계정이라, 미지정 시 signBlob 대상이
 * firebase-adminsdk가 아닌 compute로 잡혀 권한 오류가 나기 쉽습니다.
 * `FIREBASE_SIGNING_SERVICE_ACCOUNT_EMAIL`로 덮어쓸 수 있습니다.
 */
function adminCustomTokenSignerServiceAccountId(): string | undefined {
  const explicit = process.env.FIREBASE_SIGNING_SERVICE_ACCOUNT_EMAIL?.trim();
  if (explicit) return explicit;
  const projectId =
    process.env.GCLOUD_PROJECT?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim();
  if (!projectId) return undefined;
  return `${projectId}@appspot.gserviceaccount.com`;
}

if (!admin.apps.length) {
  const serviceAccountId = adminCustomTokenSignerServiceAccountId();
  if (serviceAccountId) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      serviceAccountId,
    });
  } else {
    admin.initializeApp();
  }
}

setGlobalOptions({maxInstances: 10, region: "asia-northeast3"});

/**
 * 기존 문서 경로용 — Firestore 문서 ID는 대소문자를 구분하므로 소문자 강제 없음.
 * (예전 addDoc 자동 ID·혼합 대소문자 ID와 호환)
 */
function requireAcademyDocumentId(raw: unknown): string {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    throw new HttpsError("invalid-argument", "학원 ID를 입력해 주세요.");
  }
  if (id.includes("/")) {
    throw new HttpsError("invalid-argument", "유효하지 않은 학원 ID입니다.");
  }
  if (id.length > 800) {
    throw new HttpsError("invalid-argument", "유효하지 않은 학원 ID입니다.");
  }
  return id;
}

/**
 * 오너 전용 — 학원 문서 삭제. 학원 공용 로그인(포털)은 폐지됐지만 예전에 만든
 * `secrets/login` 문서가 남아 있을 수 있어 함께 지운다.
 */
export const deleteOwnerAcademy = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }

  const academyId = requireAcademyDocumentId(request.data?.academyId);

  const db = admin.firestore();
  const academyRef = db.doc(`academies/${academyId}`);
  const academySnap = await academyRef.get();
  if (!academySnap.exists) {
    throw new HttpsError("not-found", "학원을 찾을 수 없습니다.");
  }
  if (academySnap.get("ownerUid") !== uid) {
    throw new HttpsError("permission-denied", "학원을 삭제할 권한이 없습니다.");
  }

  const batch = db.batch();
  batch.delete(academyRef);
  batch.delete(db.doc(`academies/${academyId}/secrets/login`));
  await batch.commit();

  return {ok: true};
});
export {
  sendStudentAttendanceNotification,
  syncParentPushSubscription,
  listAttendanceNotifications,
} from "./push";
export { retryAttendancePushDelivery } from "./attendance-push-delivery";
export {
  recordStudentAbsences,
  deleteStudentAttendanceRecord,
} from "./attendance-records";
export {
  addTuitionInvoiceAdjustment,
  applyAbsenceDeduction,
  removeTuitionInvoiceAdjustment,
  setTuitionInvoiceManualPaid,
} from "./tuition-invoices";
export {
  activateParent,
  deactivateParent,
  deleteAcademyStudent,
  deleteParentInvite,
  finalizeParentOnboarding,
  getParentActivationState,
  listParentChildrenStudents,
  registerParentInvite,
  sendParentInvitation,
  updateParentInvite,
} from "./parents";
export { deleteStaffMember, saveStaffMember } from "./staff";
export { saveAcademyOptionList } from "./academy-options";
export {
  acceptStaffInvite,
  cancelStaffInvite,
  checkStaffInviteLoginId,
  createStaffAccounts,
  createStaffInvite,
  getStaffInviteInfo,
} from "./staff-invites";
export {
  assignStaffRole,
  deleteAcademyRole,
  listAcademyRoles,
  saveAcademyRole,
} from "./roles";
export {
  activateTeacher,
  deactivateTeacher,
  deleteTeacherInvite,
  getTeacherActivationState,
  listTeacherAssignedStudents,
} from "./teachers";

export {
  createSeedBatch,
  deleteSeedBatch,
  listSeedBatches,
  enforceAdminLogin,
} from "./admin-seed";
export {
  adminDeleteAcademyCascade,
  adminDeleteMemberUser,
  adminReconcileActivationMirrors,
  listAdminUserDirectory,
} from "./admin-directory";
export {
  adminReconcileAcademyDashboardMeta,
  onAcademyParentDashboardMetaWritten,
  onAcademyStudentDashboardMetaWritten,
  onAcademyTeacherDashboardMetaWritten,
} from "./academy-dashboard-meta";
export {
  getAcademyKioskSettings,
  updateAcademyKioskSettings,
  verifyKioskExitPin,
  submitKioskCheckIn,
  setStudentCheckInPin,
} from "./kiosk";
export { openShortAuthLink } from "./auth-short-links";
export { sendOwnerSignupVerificationEmail } from "./owner-auth-mail";
export { issueEmailVerificationOtp, verifyEmailVerificationOtp } from "./email-verification-otp";
export {
  createAcademyEasy,
  provisionTemplateParents,
  provisionParentsBatch,
  provisionStudentsBatch,
} from "./academy-provision";
export {
  signInTeacher,
  signInTeacherGoogle,
  signInParent,
  completeMemberFirstLogin,
  regenerateMemberTempPassword,
  resetMemberPassword,
  listAcademyIssuedAccounts,
} from "./member-auth";
export {
  getParentSignupAcademyInfo,
  checkParentLoginIdAvailable,
  getParentSignupGoogleStatus,
  registerParentGoogleSignup,
  registerParentSelfSignup,
} from "./parent-self-signup";
export {
  updateTeacherProfile,
  updateParentProfile,
  syncParentGoogleLink,
  syncTeacherGoogleLink,
  checkTeacherLoginIdAvailable,
  updateTeacherLoginId,
  checkParentLoginIdForUpdate,
  updateParentLoginId,
  updateTeacherPassword,
  updateParentPassword,
} from "./member-profiles";
export {
  onTeacherMembershipWritten,
  onParentMembershipWritten,
} from "./user-activation-mirror";
export { sendTuitionReminders } from "./tuition-reminder";
export {
  sendSessionPaymentReminders,
  onStudentSessionBalanceChanged,
} from "./session-payment-reminder";
export { sendPaymentCompletedPush } from "./payment-completed-push";
