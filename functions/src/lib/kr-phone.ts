import { HttpsError } from "firebase-functions/v2/https";

export function digitsOnlyKrPhone(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 11);
}

export function normalizeKrPhoneForStorage(raw: string): string {
  const d = digitsOnlyKrPhone(raw);
  if (d.length <= 3) {
    return d;
  }
  if (d.length <= 7) {
    return `${d.slice(0, 3)}-${d.slice(3)}`;
  }
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}

/** 학부모 가입 등 — 휴대폰 번호 필수 */
export function assertKrPhoneRequired(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new HttpsError("invalid-argument", "전화번호를 입력해 주세요.");
  }
  const d = digitsOnlyKrPhone(raw);
  if (d.length < 10 || d.length > 11) {
    throw new HttpsError("invalid-argument", "올바른 휴대폰 번호(10~11자리)를 입력해 주세요.");
  }
  if (!/^01[0-9]/.test(d)) {
    throw new HttpsError("invalid-argument", "휴대폰 번호 형식을 확인해 주세요.");
  }
  return normalizeKrPhoneForStorage(raw);
}
