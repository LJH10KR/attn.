/**
 * OCTOMO 번호 확인 대상 번호 키(2-L) — 화면과 서버가 같은 규칙을 쓴다.
 * 서버 `functions/src/lib/octomo-phone-key.ts` ↔ 화면 `src/lib/phone/octomo-phone-key.ts`(같은 내용, 단위 테스트가 비교).
 */

/**
 * 숫자만 남기고 국가 번호(+82)를 0으로 바꾼 뒤, **010으로 시작하는 11자리만**(OCTOMO 규격) 키로 돌려준다.
 * 아니면 빈 문자열(문자 확인 불가 → 건너뛰기 안내).
 */
export function octomoPhoneKey(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("82") && d.length === 12) d = `0${d.slice(2)}`;
  return /^010\d{8}$/.test(d) ? d : "";
}
