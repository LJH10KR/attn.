import { HttpsError } from "firebase-functions/v2/https";

/**
 * App Check 강제 여부(2-K) — `ENFORCE_APP_CHECK=1`(functions/.env.attndot)일 때만.
 * 강제 대상은 가입 단계뿐: 가입 3개(`registerParentSelfSignup`·`registerParentGoogleSignup`·`registerStaffSignup`),
 * 로그인 ID 확인 2개(`checkParentLoginIdAvailable`·`checkStaffSignupLoginId`), 번호 확인 2개(2-L `startPhoneVerification`·`checkPhoneVerification`).
 * 화면은 이 함수들을 처음 부르기 직전에만 App Check를 켠다(reCAPTCHA 평가 건수를 실제 시도로 한정).
 * 켜는 순서: 앱 사이트 키 배포 → 콘솔 지표로 토큰 확인 → 이 플래그로 함수 강제(순서가 바뀌면 가입이 모두 막힘).
 */
export const APP_CHECK_ENFORCED = process.env.ENFORCE_APP_CHECK === "1";

/** 가입 단계 Callable 옵션(일반 토큰 — 입력 중 자동으로 여러 번 나가는 로그인 ID 확인, 코드 발급) */
export const SIGNUP_APP_CHECK_OPTIONS = { enforceAppCheck: APP_CHECK_ENFORCED } as const;

/**
 * 한 번씩 누르는 동작(가입 3개·번호 확인 조회) — 1회용 토큰(2-L).
 * 화면은 `httpsCallable(…, { limitedUseAppCheckTokens: true })`로 부를 때마다 새 토큰을 받는다.
 * 서버는 토큰을 소비(`verifyToken(…, { consume: true })`)하고, 이미 쓴 토큰이면 `assertFreshAppCheck`가 거부한다.
 * 소비는 1회용 토큰이 아니어도 일어난다(Admin SDK: 이 옵션으로 보낸 토큰은 무엇이든 소비 표시) — 그래서
 * 일반(재사용) 토큰으로 두 번 부르면 두 번째부터 거부된다. 이 함수들은 반드시 1회용 토큰으로 부를 것.
 */
export const ONE_SHOT_APP_CHECK_OPTIONS = {
  enforceAppCheck: APP_CHECK_ENFORCED,
  consumeAppCheckToken: APP_CHECK_ENFORCED,
} as const;

export const MSG_APP_CHECK_REPLAYED = "보안 확인에 실패했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.";

/** 1회용 함수 앞부분 — 강제 중이고 이미 소비된 토큰이면 거부(에뮬레이터는 토큰 검증을 건너뛰어 항상 false) */
export function assertFreshAppCheck(request: { app?: { alreadyConsumed?: boolean } | undefined }): void {
  if (!APP_CHECK_ENFORCED) return;
  if (request.app?.alreadyConsumed === true) {
    throw new HttpsError("unauthenticated", MSG_APP_CHECK_REPLAYED);
  }
}
