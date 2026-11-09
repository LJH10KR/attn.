/**
 * App Check 강제 여부(2-K) — `ENFORCE_APP_CHECK=1`(functions/.env.attndot)일 때만.
 * 강제 대상은 가입 단계 5개뿐: 가입 3개(`registerParentSelfSignup`·`registerParentGoogleSignup`·`registerStaffSignup`)와
 * 로그인 ID 확인 2개(`checkParentLoginIdAvailable`·`checkStaffSignupLoginId`).
 * 화면은 가입 폼에서 이 함수들을 처음 부르기 직전에만 App Check를 켠다(reCAPTCHA 평가 건수를 실제 가입 시도로 한정).
 * 켜는 순서: 앱 사이트 키 배포 → 콘솔 지표로 토큰 확인 → 이 플래그로 함수 강제(순서가 바뀌면 가입이 모두 막힘).
 */
export const APP_CHECK_ENFORCED = process.env.ENFORCE_APP_CHECK === "1";

/** 가입 단계 Callable 옵션 */
export const SIGNUP_APP_CHECK_OPTIONS = { enforceAppCheck: APP_CHECK_ENFORCED } as const;
