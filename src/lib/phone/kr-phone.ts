/** 한국 휴대폰 번호: 3-4-4 (최대 11자리) */
export const KR_PHONE_DIGIT_MAX = 11;

/** `010-1234-5678` 형식 최대 길이 */
export const KR_PHONE_INPUT_MAX_LENGTH = 13;

export function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, KR_PHONE_DIGIT_MAX);
}

/** 입력 중 실시간 하이픈 삽입 (3)-(4)-(4) */
export function formatKrPhoneInput(raw: string): string {
  const d = digitsOnly(raw);
  if (d.length <= 3) return d;
  if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}

/** 저장값·임의 문자열 → 표시용 010-1234-5678 */
export function formatKrPhoneDisplay(phone: string | null | undefined): string {
  if (!phone?.trim()) return "";
  const d = digitsOnly(phone);
  if (!d) return phone.trim();
  return formatKrPhoneInput(d);
}

export function formatKrPhoneDisplayOrDash(phone: string | null | undefined): string {
  return formatKrPhoneDisplay(phone) || "—";
}

/** 키오스크: 010-****-1234 (앞 3·끝 4만 노출) */
export function maskKrPhoneForKiosk(phone: string | null | undefined): string | null {
  const d = digitsOnly(phone ?? "");
  if (d.length < 4) return null;
  const prefix = d.length >= 3 ? d.slice(0, 3) : "";
  const last4 = d.slice(-4);
  if (prefix) return `${prefix}-****-${last4}`;
  return `***-****-${last4}`;
}

export function phoneLast4Digits(phone: string | null | undefined): string | null {
  const d = digitsOnly(phone ?? "");
  if (d.length < 4) return null;
  return d.slice(-4);
}

/** 목록 검색: 하이픈 유무·숫자만 입력 모두 매칭 */
/** 가입·폼 검증 — 미입력·자릿수·010 등 형식 */
export function getKrPhoneValidationError(phone: string): string | null {
  const trimmed = phone.trim();
  if (!trimmed) {
    return "전화번호를 입력해 주세요.";
  }
  const d = digitsOnly(trimmed);
  if (d.length < 10 || d.length > 11) {
    return "올바른 휴대폰 번호(10~11자리)를 입력해 주세요.";
  }
  if (!/^01[0-9]/.test(d)) {
    return "휴대폰 번호 형식을 확인해 주세요.";
  }
  return null;
}

export function phoneMatchesSearch(phone: string | null | undefined, query: string): boolean {
  if (!phone?.trim()) return false;
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const formatted = formatKrPhoneDisplay(phone).toLowerCase();
  const qDigits = digitsOnly(q);
  const phoneDigits = digitsOnly(phone);
  if (formatted.includes(q)) return true;
  if (qDigits.length > 0 && phoneDigits.includes(qDigits)) return true;
  return false;
}
