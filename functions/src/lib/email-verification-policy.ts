/**
 * 원장 이메일 인증 판단(3-A 후속 [Fix]) — Firestore·Auth를 부르지 않는 순수 함수만.
 * - F1 `decideAutoIssue`: 인증 창이 열릴 때 자동 발송을 할지(최근 보낸 유효 코드가 있으면 새로 만들지 않음).
 * - F2 `googleEmailVerificationDecision`: 연결된 Google 이메일이 계정 이메일과 같으면 인증으로 바꿀지.
 * 단위 테스트 `functions/test/email-verification.test.mjs`.
 */

/** 코드 유효 시간 */
export const OTP_TTL_MS = 15 * 60 * 1000;
/** [다시 받기] 재발송 제한 */
export const RESEND_COOLDOWN_MS = 60 * 1000;
/** 검증 시도 상한 */
export const OTP_MAX_ATTEMPTS = 5;
/** 자동 발송이 재사용하는 "최근 코드" — 10분 안에 보냈고 만료까지 5분 이상 남은 코드 */
export const AUTO_REUSE_WINDOW_MS = 10 * 60 * 1000;
export const AUTO_REUSE_MIN_REMAINING_MS = 5 * 60 * 1000;

export type AutoIssueDecision = "send" | "recent" | "cooldown";

/**
 * 자동 발송 판단. 메일이 실제로 나간 코드(`deliveredAtMs`)만 본다 — 보내기에 실패한 코드는
 * recent·cooldown이 되지 않는다(B1).
 * - recent: 같은 이메일로 10분 안에 보냈고, 만료까지 5분 이상 남았고, 시도 횟수가 남은 코드 → 새로 만들지 않음
 * - cooldown: recent는 아니지만 60초 안에 보낸 코드(예: 시도 횟수를 다 쓴 직후) → 새로 만들지 않음
 * - send: 그 밖
 */
export function decideAutoIssue(p: {
  now: number;
  deliveredAtMs: number | null;
  expiresAtMs: number | null;
  attempts: number;
  storedEmail: string | null;
  email: string;
}): AutoIssueDecision {
  if (p.deliveredAtMs == null) return "send";
  const sinceSent = p.now - p.deliveredAtMs;
  if (sinceSent < 0) return "cooldown"; // 시계 차이 — 방금 보낸 것으로 본다
  const sameEmail = (p.storedEmail ?? "").trim().toLowerCase() === p.email.trim().toLowerCase();
  const remaining = p.expiresAtMs == null ? 0 : p.expiresAtMs - p.now;
  if (
    sameEmail &&
    sinceSent < AUTO_REUSE_WINDOW_MS &&
    remaining >= AUTO_REUSE_MIN_REMAINING_MS &&
    p.attempts < OTP_MAX_ATTEMPTS
  ) {
    return "recent";
  }
  if (sinceSent < RESEND_COOLDOWN_MS) return "cooldown";
  return "send";
}

/** 로그인 ID 계정(직원·학부모 발급형)의 Auth 내부 이메일 */
export const PROVISION_INTERNAL_EMAIL_SUFFIX = "@provision.attndot.internal";

export type GoogleEmailDecision =
  | "already"
  | "verify"
  | "no_email"
  | "internal"
  | "no_google"
  | "mismatch";

function normEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/**
 * F2 — Admin `getUser` 결과만 보고 판단(클라이언트 값은 믿지 않음).
 * google.com 제공자의 이메일이 계정 이메일과 같을 때만 "verify". 다른 사람 이메일로 만든 비밀번호 계정에
 * 자기 Google을 연결해도 Google 이메일이 다르면 "mismatch".
 */
export function googleEmailVerificationDecision(user: {
  email?: string | null;
  emailVerified?: boolean;
  providerData?: ReadonlyArray<{ providerId?: string | null; email?: string | null }>;
}): GoogleEmailDecision {
  if (user.emailVerified) return "already";
  const email = normEmail(user.email);
  if (!email) return "no_email";
  if (email.endsWith(PROVISION_INTERNAL_EMAIL_SUFFIX)) return "internal";
  const google = (user.providerData ?? []).filter((p) => p?.providerId === "google.com");
  if (google.length === 0) return "no_google";
  return google.some((p) => normEmail(p.email) === email) ? "verify" : "mismatch";
}
