import { FirebaseError } from "firebase/app";

/** App Check 강제 함수가 토큰 없이 거부될 때(SDK 문구 "Unauthenticated") 보여 줄 안내 */
export const SIGNUP_APP_CHECK_FAILED_MESSAGE =
  "보안 확인에 실패했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.";

/** 가입 링크가 없거나 무효일 때 — 서버 `MSG_SIGNUP_LINK_INVALID`와 같은 문구(서버를 부르기 전 화면 판단용) */
export const SIGNUP_LINK_INVALID_MESSAGE =
  "가입 링크가 올바르지 않거나 더 이상 쓸 수 없습니다. 학원에서 받은 새 가입 QR로 들어와 주세요.";

/** 가입 화면 오류 문구 — App Check 거부는 안내 문구로, 나머지는 서버 문구 그대로 */
export function signupErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof FirebaseError) {
    if (err.code === "functions/unauthenticated" && err.message === "Unauthenticated") {
      return SIGNUP_APP_CHECK_FAILED_MESSAGE;
    }
    if (err.message) return err.message;
  }
  return fallback;
}

/** 가입 QR 토큰 형식(서버와 같음) — 형식이 틀리면 서버를 부르지 않고 바로 안내 */
export function readSignupToken(raw: string | null): string | null {
  const t = raw?.trim() ?? "";
  return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
}
