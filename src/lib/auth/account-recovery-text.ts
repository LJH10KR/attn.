/**
 * 아이디·비밀번호 찾기(2-M, M1) 화면 문구 — 서버 `functions/src/lib/account-recovery.ts`의 판단 결과(status)에 맞춘다.
 * 비밀번호 찾기 실패는 이유를 나누지 않는 한 문구(M1-2).
 */
export const RECOVERY_TEXT = {
  noMatch: "입력한 정보와 맞는 계정이 없거나, 번호 확인을 하지 않은 계정이에요. 학원에 문의해 주세요.",
  google: "이 계정은 Google로 로그인해요. 로그인 화면에서 [Google 계정으로 로그인]을 눌러 주세요.",
  limited: "오늘은 이 아이디로 더 시도할 수 없어요. 내일 다시 시도하거나 학원에 문의해 주세요.",
  unavailable: "지금은 번호 확인을 할 수 없어요. 잠시 후 다시 시도하거나 학원에 문의해 주세요.",
  expired: "시간이 지났어요. 처음부터 다시 해 주세요.",
  resetDone: "비밀번호를 바꿨어요. 다른 기기의 로그인은 모두 끊겼어요.",
  findNone:
    "이 번호로 확인된 계정이 없어요. 가입할 때 번호 확인을 건너뛰었거나 학원이 만들어 준 계정이면 학원에 문의해 주세요.",
  inactive: "사용 중지됨 — 학원에 문의해 주세요",
  ownerNote: "원장 계정은 이메일로 로그인해요. 비밀번호는 원장 로그인 화면의 [비밀번호 재설정]으로 바꿀 수 있어요.",
} as const;

export type RecoveryRole = "parent" | "teacher";

export function readRecoveryRole(raw: string | null): RecoveryRole | null {
  return raw === "parent" || raw === "teacher" ? raw : null;
}

export function memberLoginHref(role: RecoveryRole, loginId?: string | null): string {
  const base = role === "parent" ? "/login/parent" : "/login/teacher";
  return loginId ? `${base}?loginId=${encodeURIComponent(loginId)}` : base;
}
