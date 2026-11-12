/**
 * 휴대폰 번호 확인(OCTOMO MO 방식, 2-L) 화면 도우미 — 문자 앱 링크·QR 내용·기기 판단.
 * 사용자가 자기 휴대폰으로 1666-3538에 서버가 준 숫자 6자리를 보내면, 서버가 OCTOMO로 그 문자가 왔는지 조회한다.
 */

export const OCTOMO_INBOUND_NUMBER = "16663538";
export const OCTOMO_INBOUND_DISPLAY = "1666-3538";

export const OCTOMO_NOTICE = "휴대폰 번호 확인은 OCTOMO(주식회사 옥토버스)를 통해 진행됩니다.";

/** iPhone·iPad(데스크톱 모드 iPad는 Macintosh + 터치) */
export function isIosUserAgent(ua: string, maxTouchPoints = 0): boolean {
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1);
}

/** 문자 앱을 바로 열 수 있는 기기(휴대폰·태블릿) */
export function isMobileUserAgent(ua: string, maxTouchPoints = 0): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || isIosUserAgent(ua, maxTouchPoints);
}

/**
 * 문자 앱 링크 — 받는 번호와 본문(숫자 6자리)을 채운다.
 * iOS는 `sms:번호&body=`, 그 밖(Android 등)은 `sms:번호?body=`(형식 차이). iPhone 홈 화면 앱에서의 동작은 배포 뒤 실기기 확인.
 */
export function smsHref(code: string, ios: boolean): string {
  const body = encodeURIComponent(code);
  return ios ? `sms:${OCTOMO_INBOUND_NUMBER}&body=${body}` : `sms:${OCTOMO_INBOUND_NUMBER}?body=${body}`;
}

/** PC 화면 QR — 휴대폰 카메라 앱이 문자 작성으로 여는 표준 형식(`SMSTO:번호:본문`, iOS·Android 카메라 공통) */
export function smsQrPayload(code: string): string {
  return `SMSTO:${OCTOMO_INBOUND_NUMBER}:${code}`;
}
