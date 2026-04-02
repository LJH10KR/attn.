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

/** 학원 소속 선생님 — 문서 ID = 해당 선생님의 Auth uid */
export type AcademyTeacher = {
  userId: string;
  displayName?: string;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
};

/** 학원 소속 학부모 — 문서 ID = 해당 학부모의 Auth uid */
export type AcademyParent = {
  userId: string;
  displayName?: string;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
};

/** 학생 — 부모와 연결, Auth 없을 수 있음 */
export type AcademyStudent = {
  parentUserId: string;
  name: string;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
};
