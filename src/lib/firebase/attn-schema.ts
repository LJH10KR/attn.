import type { Timestamp } from "firebase/firestore";

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
} as const;

export function academyPath(academyId: string) {
  return `${COLLECTIONS.academies}/${academyId}`;
}

export function academyTeachersPath(academyId: string) {
  return `${academyPath(academyId)}/teachers`;
}

export function academyParentsPath(academyId: string) {
  return `${academyPath(academyId)}/parents`;
}

export function academyStudentsPath(academyId: string) {
  return `${academyPath(academyId)}/students`;
}

/** 학원 포털 비밀번호 — `secrets/login` 문서, 클라이언트 규칙으로 읽기 불가 */
export function academySecretsLoginPath(academyId: string) {
  return `${academyPath(academyId)}/secrets/login`;
}

/** 모든 로그인 사용자 공통 프로필 (선택) */
export type UserProfile = {
  displayName?: string | null;
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
 * 학원 문서 — Firestore 문서 ID가 곧 포털 로그인용 학원 ID(오너가 `createAcademyWithPortal`으로 지정).
 * owner 한 명이 여러 학원을 가질 수 있음.
 */
export type Academy = {
  ownerUid: string;
  name: string;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
  /** 필요 시: 운영 상태 등 */
  status?: "active" | "archived";
};

/**
 * 학원 선생님 — 초청 전에는 임의 문서 ID, 초청 발송 후 `authUid` 부여 및 문서 ID를 Auth uid로 이전.
 * 생성·수정·삭제는 Cloud Functions(Admin SDK)만 수행.
 */
export type TeacherRegistrationStatus =
  | "invitation_needed"
  | "invitation_sent"
  | "pending_registration"
  | "active"
  | "inactive";

/** 초청 메일 발송 시점부터 학원이 안내하는 유효 창 (밀리초) — Functions·UI에서 동일 값 사용 */
export const TEACHER_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/** 학부모 초청 — 선생님과 동일 24h */
export const PARENT_INVITE_TTL_MS = TEACHER_INVITE_TTL_MS;

/** 학부모 등록 단계 — 선생님과 동일 상태 값 */
export type ParentRegistrationStatus = TeacherRegistrationStatus;

export type AcademyTeacher = {
  email: string;
  displayName: string;
  subject?: string | null;
  phone?: string | null;
  academyId: string;
  status: TeacherRegistrationStatus;
  authUid?: string | null;
  invitedAt?: Timestamp | null;
  /** 초청 발송(또는 재발송) 시각 + 24시간 — 대시보드 카운트다운·서버 검증에 사용 */
  invitationExpiresAt?: Timestamp | null;
  onboardingCompleteAt?: Timestamp | null;
  activatedAt?: Timestamp | null;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
};

/**
 * 학원 학부모 — 초청 전 임의 문서 ID, 초청 발송 후 authUid 부여 및 문서 ID를 Auth uid로 이전.
 * 생성·수정·삭제는 Cloud Functions만 수행.
 */
export type AcademyParent = {
  email: string;
  displayName: string;
  phone?: string | null;
  emergencyContact?: string | null;
  childrenCount: number;
  academyId: string;
  status: ParentRegistrationStatus;
  authUid?: string | null;
  invitedAt?: Timestamp | null;
  invitationExpiresAt?: Timestamp | null;
  onboardingCompleteAt?: Timestamp | null;
  activatedAt?: Timestamp | null;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
};

/** 학생 — 부모와 연결, Auth 없을 수 있음 */
export type AcademyStudent = {
  parentUserId: string;
  name: string;
  /** 만 나이 등 정수(0~120) */
  age: number;
  phone?: string | null;
  emergencyContact?: string | null;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
};

/** 학원이 학부모당 등록 가능한 학생(자녀) 상한 */
export const MAX_STUDENTS_PER_PARENT = 20;
