import {setGlobalOptions} from "firebase-functions";
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

// 원장 학원 삭제 — 2-N에서 전체 정리로 바꾸며 파일을 옮김(함수 이름 같음 → 배포 시 갱신)
export { deleteOwnerAcademy } from "./academy-delete";
export { getAccountWithdrawalInfo, withdrawAccount } from "./account-withdrawal";
export { adminOrphanData } from "./admin-orphan-data";
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
  recordStudentArrival,
  recordClassAttendance,
  cancelClassAttendance,
  cancelStudentArrival,
} from "./attendance";
export {
  addTuitionInvoiceAdjustment,
  applyAbsenceDeduction,
  removeTuitionInvoiceAdjustment,
  setTuitionInvoiceManualPaid,
} from "./tuition-invoices";
export {
  deleteAcademyStudent,
  onAcademyStudentParentLinksWritten,
  saveStudent,
} from "./students";
export { createStudentsBulk } from "./students-bulk";
export { createStaffPreRegistrations } from "./staff-bulk";
export { getAcademyOnboarding, updateAcademyOnboarding } from "./onboarding";
export { findLoginIdsByPhone, verifyPasswordResetTarget, resetPasswordWithPhone } from "./account-recovery";
export {
  activateParent,
  deactivateParent,
  deleteParentAccount,
  getParentActivationState,
  listParentChildrenStudents,
} from "./parents";
export {
  createParentAccount,
  linkParentToStudents,
  unlinkParentFromStudent,
} from "./parent-links";
export {
  deleteClass,
  onAcademyClassWritten,
  reorderClasses,
  saveClass,
  setClassStudents,
} from "./classes";
export { deleteStaffMember, saveStaffMember } from "./staff";
export { saveAcademyOptionList } from "./academy-options";
export { createStaffAccounts } from "./staff-accounts";
export {
  approveStaffSignupAsExisting,
  checkStaffSignupLoginId,
  getStaffSignupInfo,
  registerStaffSignup,
  setStaffSignupRole,
} from "./staff-signup";
export { getSignupLink, regenerateSignupLink, setParentAutoLink, setSignupLinkEnabled } from "./signup-links";
export { declineParentChildLink, resolveParentPhoneNotice } from "./parent-self-service";
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
export { sendOwnerSignupVerificationEmail } from "./owner-auth-mail";
export { startPhoneVerification, checkPhoneVerification } from "./phone-verification";
export { getOwnerConsentState, recordOwnerConsent } from "./legal-consent";
export { issueEmailVerificationOtp, verifyEmailVerificationOtp } from "./email-verification-otp";
export { createAcademyEasy } from "./academy-provision";
export {
  signInTeacher,
  signInTeacherGoogle,
  signInParent,
  reauthenticateMember,
  completeMemberFirstLogin,
  regenerateMemberTempPassword,
  resetMemberPassword,
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
