import { normalizeMemberLoginId } from "./member-login-id";
import { isAccountPhoneVerified, seoulDayKey, shortHash } from "./phone-verification";

/**
 * 아이디·비밀번호 찾기(2-M, L3-2·M1) — 판단(순수 함수)과 키.
 * 대상: 문자로 번호가 확인된 직원·학부모 계정만(`isAccountPhoneVerified` — 계정 번호 = 확인 키).
 * 비밀번호 찾기의 실패는 이유를 나누지 않는다(아이디 없음·번호 다름·번호 미확인·대상 아닌 상태 = 같은 응답).
 */

/** 비밀번호 찾기로 재설정할 수 있는 계정 상태(★8) — 사용 중·학부모 승인 대기·직원 가입 승인 대기 */
export const RECOVERY_RESET_STATUSES = ["active", "pending_approval", "pending_registration"] as const;

/** 비밀번호 찾기 한 문구 실패(M1-2) */
export const MSG_RECOVERY_NO_MATCH =
  "입력한 정보와 맞는 계정이 없거나, 번호 확인을 하지 않은 계정이에요. 학원에 문의해 주세요.";

/** 아이디가 없을 때 같은 수의 읽기를 하려고 읽는 빈 색인 키 — 로그인 ID 형식(영문·숫자·밑줄)이 될 수 없는 값 */
export const RECOVERY_DUMMY_INDEX_KEY = "recovery-none-0";
const MAX_LOGIN_ID_INPUT = 100;

export type MemberRole = "parent" | "teacher";

export function memberRoleOf(raw: unknown): MemberRole | null {
  return raw === "parent" || raw === "teacher" ? raw : null;
}

/**
 * 입력한 아이디 → 읽을 색인 키 2개(항상 2개 — 응답 시간·읽기 수를 같게).
 * 1) 정규화(영문 소문자, 한글은 그대로) 2) 입력 그대로(정규화와 같으면 빈 키). 비었거나 너무 길면 null.
 */
export function recoveryIndexKeys(raw: unknown): [string, string] | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed || trimmed.length > MAX_LOGIN_ID_INPUT) return null;
  const normalized = normalizeMemberLoginId(trimmed);
  return [normalized, trimmed === normalized ? RECOVERY_DUMMY_INDEX_KEY : trimmed];
}

/** 아이디별 하루 재설정 확인 카운터 키(★9) — 입력 문자열(정규화) 기준, 존재 여부와 무관 */
export function resetLoginIdCounterKey(normalizedLoginId: string, nowMs: number): string {
  return `reset_id_day_${shortHash(normalizedLoginId)}_${seoulDayKey(nowMs)}`;
}

export type ResetMatchInput = {
  /** 로그인 색인의 역할(없으면 null) */
  indexRole: unknown;
  /** 계정 문서(없으면 null) */
  member: { status?: unknown; phone?: unknown; phoneVerifiedKey?: unknown; authProvider?: unknown } | null;
  /** `secrets/login`에 비밀번호가 있는지 */
  hasPassword: boolean;
  /** 방금 문자로 확인한 번호(010 11자리 키) */
  proofPhoneKey: string;
};

/**
 * 비밀번호 찾기 판단(★8) — "이 아이디의 확인된 번호 = 방금 확인한 번호"이고 대상 상태일 때만.
 * Google 전용 계정(비밀번호 없음)은 다 맞을 때만 `google`. 그 밖은 모두 `no_match`(이유를 나누지 않음).
 */
export function passwordResetMatch(input: ResetMatchInput): "ok" | "google" | "no_match" {
  if (!memberRoleOf(input.indexRole) || !input.member) return "no_match";
  const m = input.member;
  if (!(RECOVERY_RESET_STATUSES as readonly unknown[]).includes(m.status)) return "no_match";
  if (!isAccountPhoneVerified(m)) return "no_match";
  if (m.phoneVerifiedKey !== input.proofPhoneKey) return "no_match";
  if (m.authProvider === "google" && !input.hasPassword) return "google";
  return "ok";
}

/** 응답 시간 하한까지 남은 시간(★10) */
export function remainingFloorMs(startedAtMs: number, nowMs: number, floorMs: number): number {
  return Math.max(0, floorMs - Math.max(0, nowMs - startedAtMs));
}

const MEMBER_PATH_RE = /^academies\/([^/]+)\/(parents|staff)\/([^/]+)$/;

export type FoundLoginAccount = {
  kind: MemberRole;
  academyId: string;
  /** 로그인 ID — Google 로그인 계정이면 null */
  loginId: string | null;
  google: boolean;
  /** 사용 중지(비활성) — 학원 문의 */
  inactive: boolean;
};

/**
 * 아이디 찾기 결과 한 줄 — 경로가 학원의 학부모·직원 계정 문서이고, 계정이 있고(계정 없는 인사 기록 제외),
 * 계정 번호가 지금도 그 확인된 번호일 때만. 아니면 null.
 */
export function foundLoginAccountOf(
  path: string,
  data: Record<string, unknown>,
  proofPhoneKey: string,
): FoundLoginAccount | null {
  const m = path.match(MEMBER_PATH_RE);
  if (!m) return null;
  if (typeof data.authUid !== "string" || !data.authUid || data.status === "no_account") return null;
  if (!isAccountPhoneVerified(data) || data.phoneVerifiedKey !== proofPhoneKey) return null;
  const google = data.authProvider === "google";
  const loginId = typeof data.loginId === "string" && data.loginId ? data.loginId : typeof data.attnId === "string" ? data.attnId : "";
  return {
    kind: m[2] === "parents" ? "parent" : "teacher",
    academyId: m[1]!,
    loginId: google ? null : loginId || null,
    google,
    inactive: data.status === "inactive",
  };
}
