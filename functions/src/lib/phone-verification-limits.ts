/**
 * 휴대폰 번호 확인(OCTOMO, 2-L) 한도 — 값은 이 파일 한곳에서만 바꾼다.
 * OCTOMO 무료 플랜은 월 10,000 **호출**(결과와 무관, 매월 1일 초기화, 넘으면 429·과금 없음)이라
 * 서비스 전체 하루 한도로 월말까지 고르게 나눈다(300 × 31 = 9,300). 학원이 늘면 OCTOMO Pro로 올리고 이 값만 바꾼다.
 * 한도를 넘거나 OCTOMO가 실패해도 가입은 막지 않는다(번호 확인 없이 승인 대기).
 */

/** OCTOMO 수신 번호(사용자가 문자를 보내는 곳) */
export const OCTOMO_INBOUND_NUMBER = "16663538";

/** 확인 코드 유효 시간 */
export const PHONE_CODE_TTL_MS = 10 * 60 * 1000;
/** 확인에 성공한 뒤 증표를 쓸 수 있는 시간(가입 폼 마저 채우기·번호 변경 저장) */
export const PHONE_PROOF_TTL_MS = 30 * 60 * 1000;
/** 확인 문서·카운터 문서 정리 시각(TTL 정책 `ttlAt`) */
export const PHONE_VERIFICATION_DOC_TTL_MS = 24 * 60 * 60 * 1000;

/** 코드 1개당 OCTOMO 조회 횟수 */
export const PHONE_CHECKS_PER_CODE = 3;
/** 같은 코드의 조회 사이 최소 간격 */
export const PHONE_CHECK_MIN_INTERVAL_MS = 5 * 1000;

/** 서비스 전체 하루(서울 날짜) OCTOMO 호출 수 */
export const OCTOMO_DAILY_CALL_LIMIT = 300;
/** 가입 링크 하나의 하루 OCTOMO 호출 수(한 링크가 퍼져도 다른 학원 확인이 멈추지 않게) */
export const OCTOMO_DAILY_CALL_LIMIT_PER_LINK = 150;

/** 코드 발급(느슨한 보조 제한) */
export const PHONE_CODES_PER_PHONE_PER_HOUR = 5;
export const PHONE_CODES_PER_PHONE_PER_DAY = 10;
export const PHONE_CODES_PER_IP_PER_HOUR = 30;
export const PHONE_CODES_PER_UID_PER_HOUR = 5;

/** OCTOMO 요청 제한 시간 */
export const OCTOMO_REQUEST_TIMEOUT_MS = 8 * 1000;
