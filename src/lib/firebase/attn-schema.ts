import type { Timestamp } from "firebase/firestore";
import type { AcademyPermission, RoleTemplateKey } from "@/lib/academy/permissions";
import type { GradeCode, StudentStatus } from "@/lib/academy/student-profile";

/**
 * attn. Firestore 데이터 모델 — 사용자·학원 계층
 *
 * Auth(Firebase Authentication)와 Firestore 역할 분리:
 * - 로그인 주체는 모두 Firebase Auth `uid`로 식별합니다.
 * - admin은 Auth Custom Claim `admin: true`로만 부여합니다 (Console/Admin SDK).
 * - owner / teacher / parent는 학원 단위 멤버십과 문서 필드로 표현합니다.
 * - student는 미성년자 등 비로그인 주체일 수 있어 `studentId`는 문서 ID(자동)를 사용합니다.
 */

/** 최상위 컬렉션 경로 */
export const COLLECTIONS = {
  users: "users",
  academies: "academies",
  attnLoginIndex: "attnLoginIndex",
} as const;

/** 발급형 멤버 상태 — v2 */
export type MemberProvisionStatus = "pending_setup" | "active" | "inactive";

export function academyPath(academyId: string) {
  return `${COLLECTIONS.academies}/${academyId}`;
}

export function academyStaffPath(academyId: string) {
  return `${academyPath(academyId)}/staff`;
}

export function academyParentsPath(academyId: string) {
  return `${academyPath(academyId)}/parents`;
}

export function academyStudentsPath(academyId: string) {
  return `${academyPath(academyId)}/students`;
}

/** `academies/{academyId}/meta/dashboardStats` — Functions 집계, 클라이언트 읽기 전용 */
export const ACADEMY_DASHBOARD_STATS_DOC_ID = "dashboardStats" as const;

export const ACADEMY_DASHBOARD_STATS_SCHEMA_VERSION = 1 as const;

export type AcademyDashboardStatsDoc = {
  schemaVersion: typeof ACADEMY_DASHBOARD_STATS_SCHEMA_VERSION;
  teachers: number;
  parents: number;
  students: number;
  teachersPending: number;
  teachersInviteNeeded: number;
  teachersInviteSent: number;
  /** 학부모 가입 승인 대기(`pending_approval` && `approvedAt == null`) */
  parentsPending: number;
  updatedAt: Timestamp;
};

export function academyDashboardStatsPath(academyId: string): string {
  return `${academyPath(academyId)}/meta/${ACADEMY_DASHBOARD_STATS_DOC_ID}`;
}

/** `academies/{academyId}/meta/kioskSettings` — 출석 키오스크(Functions 전용 쓰기) */
export const ACADEMY_KIOSK_SETTINGS_DOC_ID = "kioskSettings" as const;

export type AcademyKioskSettingsPublic = {
  requireStudentCheckInPin: boolean;
  exitPinConfigured: boolean;
  exitPinLocked: boolean;
};

export function academyKioskSettingsPath(academyId: string): string {
  return `${academyPath(academyId)}/meta/${ACADEMY_KIOSK_SETTINGS_DOC_ID}`;
}

/** `academies/{academyId}/adminInbox/{inboxId}` — 운영 알림(벨) */
export const ACADEMY_ADMIN_INBOX_SCHEMA_VERSION = 1 as const;

export type AcademyAdminInboxKind =
  /** 직원 초대 링크 가입 승인 대기·첫 로그인 전 */
  | "pending_registration"
  /** 예전 직원 초청 메일(폐지) — 남은 항목 표시용 */
  | "invitation_sent"
  /** 학부모 가입 승인 대기(연결 해제로 돌아온 계정은 만들지 않음) */
  | "parent_pending_approval"
  | "session_payment_received";

export type AcademyAdminInboxDoc = {
  schemaVersion: typeof ACADEMY_ADMIN_INBOX_SCHEMA_VERSION;
  kind: AcademyAdminInboxKind;
  /** 회차 결제 알림은 학생 단위(`student`, entityId = studentId) */
  entityType: "teacher" | "parent" | "student";
  entityId: string;
  displayName: string;
  email: string;
  invitedAt?: Timestamp | null;
  invitationExpiresAt?: Timestamp | null;
  /** kind가 "session_payment_received"일 때 사용 — 결제된 회차 수 */
  sessionCount?: number;
  /** kind가 "session_payment_received"일 때 사용 — 결제한 학생 이름 */
  studentName?: string;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
};

export function academyAdminInboxCollectionPath(academyId: string): string {
  return `${academyPath(academyId)}/adminInbox`;
}

/** 학원 포털 비밀번호 — `secrets/login` 문서, 클라이언트 규칙으로 읽기 불가 */
export function academySecretsLoginPath(academyId: string) {
  return `${academyPath(academyId)}/secrets/login`;
}

/** `users/{uid}/serverMirror/{USER_ACTIVATION_MIRROR_DOC_ID}` — Functions만 쓰기 */
export const USER_SERVER_MIRROR_COLLECTION = "serverMirror" as const;
export const USER_ACTIVATION_MIRROR_DOC_ID = "activation" as const;

/** `UserActivationMirrorDoc` 필드 `schemaVersion` — 규칙·클라 검증과 동기화 */
export const USER_ACTIVATION_MIRROR_SCHEMA_VERSION = 1 as const;

/**
 * Callable `getTeacherActivationState` / `getParentActivationState`와 동일한 의미의 스냅샷.
 * `primaryStatus` / `primaryAcademyId`는 서버가 멤버십에서 계산한 값(클라이언트가 수정 불가).
 */
export type UserRoleActivationMirrorSlice = {
  anyActive: boolean;
  primaryStatus: string | null;
  primaryAcademyId: string | null;
};

/**
 * 로그인 사용자별 선생님·학부모 활성 판별 요약(읽기 전용 미러).
 * - 경로: `users/{uid}/serverMirror/activation`
 * - 쓰기: Admin SDK(Functions)만 — `firestore.rules` 참고.
 */
export type UserActivationMirrorDoc = {
  schemaVersion: typeof USER_ACTIVATION_MIRROR_SCHEMA_VERSION;
  teacher: UserRoleActivationMirrorSlice;
  parent: UserRoleActivationMirrorSlice;
  updatedAt: Timestamp;
  /** 갱신 출처(운영·디버깅용) */
  source?: "trigger" | "reconcile" | "bootstrap";
};

export function userActivationMirrorPath(userId: string): string {
  return `${COLLECTIONS.users}/${userId}/${USER_SERVER_MIRROR_COLLECTION}/${USER_ACTIVATION_MIRROR_DOC_ID}`;
}

/** 모든 로그인 사용자 공통 프로필 (선택) */
export type UserProfile = {
  displayName?: string | null;
  phone?: string | null;
  email?: string | null;
  photoURL?: string | null;
  /** 서비스 단위 역할 (오너 가입 등) */
  platformRole?: "owner";
  emailVerified?: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  ownerOnboardedAt?: Timestamp;
};

/**
 * 학원 문서 — `createAcademyEasy` 시 Firestore 문서 ID가 attn 학원 번호(예: `o00001_a03`).
 * `createAcademyWithPortal`은 오너가 슬러그 ID를 직접 지정할 수 있음.
 * owner 한 명이 여러 학원을 가질 수 있음.
 */
export type Academy = {
  ownerUid: string;
  name: string;
  /** 공개 로그인 번호 — Firestore 문서 ID와 동일 */
  attnId?: string;
  ownerAttnSeq?: string;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
  /** 필요 시: 운영 상태 등 */
  status?: "active" | "archived";
};

/** 선생님(직원) 계정 등록 단계 — 초청 발송 후 `authUid` 부여 및 문서 ID를 Auth uid로 이전 */
export type TeacherRegistrationStatus =
  | "pending_setup"
  | "invitation_needed"
  | "invitation_sent"
  | "pending_registration"
  | "pending_email_verification"
  | "active"
  | "inactive";

/** 초청 메일 발송 시점부터 학원이 안내하는 유효 창 (밀리초) — Functions·UI에서 동일 값 사용 */
export const TEACHER_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 학부모 앱 계정 상태(`functions/src/lib/parent-links.ts` `ParentAccountStatus`와 같게).
 * 승인 대기·연결 대기(`pending_approval`)는 Auth를 끄지 않고 앱의 연결 대기 화면으로 간다. 비활성만 Auth off.
 */
export type ParentAccountStatus =
  | "pending_email_verification"
  | "pending_setup"
  | "pending_approval"
  | "active"
  | "inactive";

/**
 * 직원 계정 상태 — 계정 없이 인사 정보만 등록한 직원은 "no_account",
 * 초대 링크로 가입하면 "pending_registration"(원장 승인 대기), 학원이 직접 만들어 주면 "pending_setup"(첫 로그인 전)
 */
export type StaffAccountStatus = TeacherRegistrationStatus | "no_account";

/** 재직 상태 — 퇴사로 바꾸면 활성 계정도 서버가 비활성화(`staff.ts`) */
export type StaffEmploymentStatus = "employed" | "on_leave" | "resigned";

export const STAFF_EMPLOYMENT_STATUS_LABELS: Record<StaffEmploymentStatus, string> = {
  employed: "재직",
  on_leave: "휴직",
  resigned: "퇴사",
};

/** 미설정(이전 문서)은 재직으로 취급 */
export function readStaffEmploymentStatus(raw: unknown): StaffEmploymentStatus {
  return raw === "on_leave" || raw === "resigned" ? raw : "employed";
}

export function academyStaffDocPath(academyId: string, staffId: string) {
  return `${academyStaffPath(academyId)}/${staffId}`;
}

/**
 * 직원 — 인사 정보 + 선택적 계정이 한 문서(`academies/{academyId}/staff/{staffId}`).
 * 계정이 있으면 문서 ID = Auth uid, 계정 없는 직원·초청 전은 임의 ID.
 * 생성·수정·삭제는 Cloud Functions(Admin SDK)만 수행.
 */
export type AcademyStaff = {
  attnId?: string;
  /** 로그인용 별칭 — attnLoginIndex 키 (관리 번호와 분리) */
  loginId?: string;
  email?: string;
  displayName: string;
  subject?: string | null;
  phone?: string | null;
  /** 직무 — `meta/options.jobTitles`의 id(지워진 id면 없음으로 표시) */
  jobTitleId?: string | null;
  /** 입사일 YYYY-MM-DD */
  hireDate?: string | null;
  employmentStatus?: StaffEmploymentStatus;
  memo?: string;
  /** 인사 정보 없이 계정만 있는 게스트 — 직원 목록에서 숨김 */
  isGuest?: boolean;
  /** 초대 링크 대기 중(계정 없음일 때) — 링크 원문은 서버도 보관하지 않음(`staffInvites/{sha256}`) */
  inviteRoleId?: string;
  inviteExpiresAt?: Timestamp;
  academyId: string;
  status: StaffAccountStatus;
  authProvider?: "password" | "google";
  googleLinked?: boolean;
  googleEmail?: string;
  authUid?: string | null;
  invitedAt?: Timestamp | null;
  /** 초청 발송(또는 재발송) 시각 + 24시간 — 대시보드 카운트다운·서버 검증에 사용 */
  invitationExpiresAt?: Timestamp | null;
  onboardingCompleteAt?: Timestamp | null;
  activatedAt?: Timestamp | null;
  /** 배정된 역할(`academies/{academyId}/roles/{roleId}`) */
  roleId?: string | null;
  /** 역할에서 서버가 복사한 세부 권한 — 보안 규칙이 이 필드로 판별(클라이언트 쓰기 불가) */
  permissions?: AcademyPermission[];
  createdAt: Timestamp;
  updatedAt?: Timestamp;
};

/** `academies/{academyId}/meta/options` — 종류별 선택지 `{id, label}[]`(쓰기는 `saveAcademyOptionList`만) */
export const ACADEMY_OPTIONS_DOC_ID = "options" as const;

export type AcademyOptionListKind = "jobTitles" | "guardianRelations" | "rooms";

export type AcademyOptionItem = { id: string; label: string };

export function academyOptionsPath(academyId: string): string {
  return `${academyPath(academyId)}/meta/${ACADEMY_OPTIONS_DOC_ID}`;
}

export function academyRolesPath(academyId: string) {
  return `${academyPath(academyId)}/roles`;
}

/**
 * 학원 역할(권한 묶음) — 템플릿 역할은 문서 ID = 템플릿 키.
 * 생성·수정·삭제·배정은 Functions(`roles.ts`)만 수행.
 */
export type AcademyRoleDoc = {
  name: string;
  permissions: AcademyPermission[];
  template: RoleTemplateKey | null;
  sortOrder: number;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
};

/**
 * 학원 학부모 앱 계정 — 문서 ID = Auth uid. 생성·수정·삭제는 Cloud Functions만 수행.
 * 자녀 연결의 원본은 학생 `guardians[].linkedParentUid`이고 `linkedStudentIds`는 서버 트리거가 맞추는 요약.
 */
export type AcademyParent = {
  attnId?: string;
  loginId?: string;
  /** 인증 코드 수신용 연락 이메일 (자가 가입) */
  contactEmail?: string;
  contactEmailVerified?: boolean;
  email: string;
  displayName: string;
  phone?: string | null;
  academyId: string;
  status: ParentAccountStatus;
  authUid?: string | null;
  authProvider?: "password" | "google";
  signupSource?: "parent_link" | "parent_link_google" | "academy_created";
  /** 연결 자녀 id(서버 트리거) */
  linkedStudentIds?: string[];
  /** 첫 연결(승인) 시각 — 생성 때 null. `pending_approval`인데 값이 있으면 "연결 해제됨" */
  approvedAt?: Timestamp | null;
  approvedByUid?: string | null;
  /** 푸시 수신 상태 요약(`syncParentPushSubscription`) */
  pushEnabled?: boolean;
  pushTokenCount?: number;
  pushSyncedAt?: Timestamp;
  activatedAt?: Timestamp | null;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
};

/** 반 상태 — 운영중·준비중·종강(종강 반은 학생 `teacherUids` 계산에서 빠짐, 원생 추가 불가) */
export type AcademyClassStatus = "active" | "preparing" | "ended";

/** 수업 시간 한 칸 — 요일 월=1~일=7 */
export type AcademyClassScheduleSlot = { weekday: number; start: string; end: string };

/**
 * `academies/{academyId}/classes/{classId}` — 쓰기는 Functions(`classes.ts`)만, 원장·활성 직원 읽기.
 * 원생 수는 저장하지 않는다(학생 `classIds array-contains`로 셈).
 */
export type AcademyClass = {
  name: string;
  status: AcademyClassStatus;
  schedule: AcademyClassScheduleSlot[];
  /** 원장 uid 또는 계정이 있는 직원 uid, 최대 10명 */
  teacherUids: string[];
  /** `meta/options.rooms` 선택지 id — 지운 선택지면 "강의실 미지정" */
  roomId: string | null;
  capacity: number | null;
  sortOrder: number;
  endedAt?: Timestamp | null;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
};

/** 원비 납부 방식 */
export type TuitionType = "monthly_fixed" | "session_based";

/** 원생 보호자 연락처 — 보호자 정보의 원본(`functions/src/lib/student-guardians.ts`) */
export type StudentGuardian = {
  id: string;
  /** `meta/options.guardianRelations` 선택지 id */
  relationId: string | null;
  name: string | null;
  phone: string;
  isPrimary: boolean;
  /** 연결된 학부모 앱 계정 — 서버 연결 함수만 씀 */
  linkedParentUid: string | null;
};

/**
 * 원생 — 학부모 계정 없이 먼저 존재(원생 중심 모델). 생성·원생 정보 수정은 서버(`saveStudent`)만.
 * 학원 내부 메모는 `studentNotes/{studentId}`(학부모가 읽지 못함).
 */
export type AcademyStudent = {
  /** `{academyId}_s{n}` — 학부모 번호와 분리 */
  attnId?: string;
  name: string;
  grade?: GradeCode;
  /** grade를 저장한 해(서울) — 표시 학년은 `displayGrade` */
  gradeYear?: number;
  school?: string | null;
  /** 학생 본인 번호(선택) */
  phone?: string | null;
  status?: StudentStatus;
  statusChangedAt?: Timestamp;
  firstAttendedOn?: string | null;
  guardians?: StudentGuardian[];
  /** 보호자 번호(숫자만) — 서버 파생, 번호 매칭 쿼리용 */
  guardianPhones?: string[];
  /** 연결된 보호자 계정 — 서버 파생, 학부모 읽기 규칙·푸시 대상 */
  parentUids?: string[];
  /** 배정된 반 — 반 배정 함수만 */
  classIds?: string[];
  /** 반 담당 선생님 — `classIds`의 반(종강 제외) 선생님 합집합, 서버 파생. 선생님 읽기 규칙이 이 필드로 판별 */
  teacherUids?: string[];
  /** 매월 지정일 납부 — tuitionType이 "monthly_fixed"이거나 미설정(학원 기본값) 시 사용 */
  tuitionDueDayOfMonth?: number;
  tuitionAmount?: number;
  sentTuitionReminders?: string[];
  /** 학생별 납부 방식 재정의 — 미설정 시 학원 defaultTuitionType 상속 */
  tuitionType?: TuitionType;
  /** 회차 방식 — 주당 기본 수업 횟수 (1~7) */
  weeklySessionCount?: number;
  /** 회차당 수업료 (원) */
  pricePerSession?: number;
  /** 잔여 선결제 횟수 — 음수는 초과 수업 부채 */
  sessionBalance?: number;
  /** 초과 수업이 발생한 날짜 목록 (YYYY-MM-DD) — 충전 시 초기화 */
  extraSessionDates?: string[];
  /** 회차 납부 안내 FCM 발송 여부 — 충전 시 초기화 */
  sentSessionPaymentReminder?: boolean;
  /** 학부모가 납부 안내 알림을 확인한 시각 — 충전 시 초기화 */
  tuitionReminderConfirmedAt?: Timestamp;
  /** 납부 알림을 확인한 학부모 uid */
  tuitionReminderConfirmedByUid?: string;
  /** 결석 차감 1일당 금액(원) — 미설정 시 학원 `absenceDeductionSettings` 기본값 사용 */
  absenceDeductionPerDay?: number;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
};

/** 학원이 학부모당 등록 가능한 학생(자녀) 상한 */
export const MAX_STUDENTS_PER_PARENT = 20;

/** `academies/{academyId}/meta/tuitionSettings` — 원장이 설정하는 납부 안내 정보 */
export const ACADEMY_TUITION_SETTINGS_DOC_ID = "tuitionSettings" as const;

export type AcademyTuitionSettingsDoc = {
  kakaoPayLink: string;
  bankName: string;
  accountNumber: string;
  accountHolder: string;
  /**
   * 포트원 채널 키 — 학원별 프로덕션(나이스정보통신) 채널로 실연동 전환 시 사용.
   * 테스트 단계에서는 비어있을 수 있으며, 그 경우 클라이언트는
   * `NEXT_PUBLIC_PORTONE_CHANNEL_KEY`(공용 테스트 채널)로 폴백합니다.
   */
  channelKey?: string;
  updatedAt?: Timestamp;
};

export function academyTuitionSettingsPath(academyId: string): string {
  return `${academyPath(academyId)}/meta/${ACADEMY_TUITION_SETTINGS_DOC_ID}`;
}

/** `academies/{academyId}/meta/sessionTuitionSettings` — 회차 방식 기본 설정 */
export const ACADEMY_SESSION_TUITION_SETTINGS_DOC_ID = "sessionTuitionSettings" as const;

export type AcademySessionTuitionSettingsDoc = {
  defaultTuitionType: TuitionType;
  updatedAt?: Timestamp;
};

export function academySessionTuitionSettingsPath(academyId: string): string {
  return `${academyPath(academyId)}/meta/${ACADEMY_SESSION_TUITION_SETTINGS_DOC_ID}`;
}

/** `academies/{academyId}/meta/absenceDeductionSettings` — 결석 차감 제안 기본값(오너·포털 쓰기) */
export const ACADEMY_ABSENCE_DEDUCTION_SETTINGS_DOC_ID = "absenceDeductionSettings" as const;

/** per_day: 1일 고정 금액 · divide: 학생 원비 ÷ 월 수업일수 */
export type AbsenceDeductionMethod = "per_day" | "divide";

export type AcademyAbsenceDeductionSettingsDoc = {
  method: AbsenceDeductionMethod;
  /** method가 "per_day"일 때 1일 차감액(원) */
  perDayAmount?: number;
  /** method가 "divide"일 때 월 기준 수업일수(1~31) */
  monthlyClassDays?: number;
  updatedAt?: Timestamp;
};

export function academyAbsenceDeductionSettingsPath(academyId: string): string {
  return `${academyPath(academyId)}/meta/${ACADEMY_ABSENCE_DEDUCTION_SETTINGS_DOC_ID}`;
}

/** `academies/{academyId}/students/{studentId}/sessionLogs/{logId}` */
export type SessionLogDoc = {
  recordedAt: Timestamp;
  recordedByUid: string;
  /** 기록 시점에 sessionBalance가 0 이하였던 경우 true (초과 수업) */
  wasExtra: boolean;
};

export function academyStudentSessionLogsPath(academyId: string, studentId: string): string {
  return `${academyStudentsPath(academyId)}/${studentId}/sessionLogs`;
}

/** 출결 상태 */
export type AttendanceStatus = "present" | "absent";

/** 결석 사유 — illness·academy는 학원 측 사유로 원비 차감 대상, 원장·포털만 지정 가능 */
export type AbsenceReason = "general" | "illness" | "academy";

export const ABSENCE_REASONS: readonly AbsenceReason[] = ["general", "illness", "academy"];

export const ABSENCE_REASON_LABELS: Record<AbsenceReason, string> = {
  general: "일반",
  illness: "질병",
  academy: "학원 사정",
};

export function isAbsenceReason(raw: unknown): raw is AbsenceReason {
  return typeof raw === "string" && (ABSENCE_REASONS as readonly string[]).includes(raw);
}

/**
 * `academies/{academyId}/students/{studentId}/attendanceRecords/{YYYY-MM-DD}` — 학생·날짜당 1건.
 * 쓰기는 Functions(`sendStudentAttendanceNotification`, `submitKioskCheckIn`, `recordStudentAbsences`,
 * `deleteStudentAttendanceRecord`)만, 읽기는 학원(오너·포털)만.
 */
export type AttendanceRecordDoc = {
  /** 서울 기준 날짜 — 문서 ID와 동일 */
  date: string;
  status: AttendanceStatus;
  /** status가 "absent"일 때만 */
  reason?: AbsenceReason;
  note?: string;
  recordedByUid: string;
  recordedByRole: "teacher" | "owner" | "academy" | "student_kiosk";
  source: "teacher_dashboard" | "academy_dashboard" | "student_kiosk";
  /**
   * 결석 차감이 반영된 청구서(YYYY-MM)·조정 항목 id — 설정된 동안 기록은 수정·삭제 불가(잠금).
   * 해당 조정 항목을 삭제하면 해제됨.
   */
  billedInvoicePeriod?: string;
  billedAdjustmentId?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export function academyStudentAttendanceRecordsPath(academyId: string, studentId: string): string {
  return `${academyStudentsPath(academyId)}/${studentId}/attendanceRecords`;
}

/** 청구서 조정 항목 — amount 음수는 차감, 양수는 추가 */
export type TuitionInvoiceAdjustment = {
  id: string;
  amount: number;
  memo: string;
  /** manual: 원장 직접 입력 · absence: 결석 기록 기반 차감(`applyAbsenceDeduction`) */
  source: "manual" | "absence";
  /** source가 "absence"일 때 차감 근거가 된 결석 날짜(YYYY-MM-DD)와 1일 차감액 */
  absenceDates?: string[];
  perDayAmount?: number;
  createdByUid: string;
  createdAt: Timestamp;
};

/** open: 미납(금액은 원비 + 조정 합계로 실시간 계산) · paid: 납부 완료(금액 고정) */
export type TuitionInvoiceStatus = "open" | "paid";

/**
 * `academies/{academyId}/students/{studentId}/tuitionInvoices/{YYYY-MM}` — 매월 지정일 납부의 월별 청구서.
 * 문서 ID·period는 납부일이 속한 달. 조정 항목이 생기거나 납부될 때 생성됨(없으면 원비 그대로 청구).
 * 쓰기는 Functions(조정·수동 납부)와 Next 서버(카드 결제 완결·취소)만, 읽기는 학원만.
 */
export type TuitionInvoiceDoc = {
  period: string;
  /** 서울 기준 YYYY-MM-DD */
  dueDate: string;
  status: TuitionInvoiceStatus;
  adjustments: TuitionInvoiceAdjustment[];
  /** status가 "paid"일 때만 — 납부 시점 원비·최종 금액 */
  baseAmount?: number;
  finalAmount?: number;
  paidAt?: Timestamp;
  /** card: 포트원 결제 · manual: 원장이 계좌이체·현금 등으로 확인 */
  paidMethod?: "card" | "manual";
  paymentId?: string;
  paidByUid?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export function academyStudentTuitionInvoicesPath(academyId: string, studentId: string): string {
  return `${academyStudentsPath(academyId)}/${studentId}/tuitionInvoices`;
}

/** 학부모 Callable(`listParentChildrenStudents`)이 내려주는 이번 납부 청구서 요약 */
export type TuitionInvoiceSummary = {
  period: string;
  dueDate: string;
  status: TuitionInvoiceStatus;
  baseAmount: number;
  adjustments: { amount: number; memo: string }[];
  finalAmount: number;
};

/** 카드 결제(포트원 V2 · 나이스정보통신) 상태 */
export type AcademyPaymentStatus = "PENDING" | "PAID" | "FAILED" | "CANCELLED";

/** `academies/{academyId}/payments/{paymentId}` — 카드 결제 이력 (paymentId는 클라이언트가 생성한 UUID) */
export type AcademyPaymentDoc = {
  paymentId: string;
  studentId: string;
  studentName: string;
  /** 결제 때 학생의 연결 보호자 — 이후 연결·해제 때 서버가 갱신(학부모 결제 내역 읽기 기준) */
  parentUids: string[];
  /** 결제한 앱 계정(결제 요청 customData, 결제 시점 `parentUids`에 있을 때만) — 표시용, 검증된 신원 아님 */
  payerUid?: string | null;
  amount: number;
  status: AcademyPaymentStatus;
  /** 결제 종류 — 미설정 시 기존 데이터와의 호환을 위해 "monthly_fixed"로 취급 */
  paymentType?: "monthly_fixed" | "session_based";
  /** paymentType이 "session_based"일 때 결제된 회차 수 */
  sessionCount?: number;
  /** paymentType이 "monthly_fixed"일 때 납부한 청구서(YYYY-MM) — 청구서 도입 이전 결제는 없음 */
  invoicePeriod?: string;
  portoneTransactionId?: string;
  cancelledAt?: Timestamp;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
};

export function academyPaymentsPath(academyId: string): string {
  return `${academyPath(academyId)}/payments`;
}

export function academyPaymentPath(academyId: string, paymentId: string): string {
  return `${academyPaymentsPath(academyId)}/${paymentId}`;
}
