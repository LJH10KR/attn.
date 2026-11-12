/**
 * 법적 고지 정보(2-O) — 대표자 성명·사업자등록번호·사업장 주소·연락 이메일·시행일.
 * 값은 코드·git에 두지 않고 관리자 화면이 Firestore `appConfig/legalInfo`에 저장한다(누구나 읽기·admin만 쓰기, `firestore.rules`).
 * 처리방침·약관 본문의 `[[키]]` 토큰과 사이트 하단 사업자 정보 줄이 이 값을 읽어 표시한다.
 *
 * 이 파일은 순수 함수만(별칭 import 없음) — `tests/unit/legal-info.test.mjs`가 Node로 바로 불러온다.
 * 형식 검사는 `firestore.rules`의 `legalInfoValid()`와 같아야 한다(규칙 테스트·단위 테스트가 같은 사례를 본다).
 */

export const LEGAL_INFO_DOC_PATH = ["appConfig", "legalInfo"] as const;

/** 상호 — 코드에 고정(O1) */
export const BUSINESS_NAME = "에이티티앤";

/** 연락 이메일 기본값(O4) — 문서가 없거나 칸이 비어 있으면 이 값을 보여 준다 */
export const DEFAULT_CONTACT_EMAIL = "attn.team@gmail.com";

export const LEGAL_INFO_FIELDS = [
  "representativeName",
  "businessNumber",
  "address",
  "contactEmail",
  "privacyEffectiveDate",
  "termsEffectiveDate",
] as const;

export type LegalInfoField = (typeof LEGAL_INFO_FIELDS)[number];

export type LegalInfo = Record<LegalInfoField, string>;

export const EMPTY_LEGAL_INFO: LegalInfo = {
  representativeName: "",
  businessNumber: "",
  address: "",
  contactEmail: "",
  privacyEffectiveDate: "",
  termsEffectiveDate: "",
};

export const LEGAL_INFO_LABELS: Record<LegalInfoField, string> = {
  representativeName: "대표자 성명",
  businessNumber: "사업자등록번호",
  address: "사업장 주소",
  contactEmail: "연락 이메일",
  privacyEffectiveDate: "처리방침 시행일",
  termsEffectiveDate: "약관 시행일",
};

/** 글자 수 한도(규칙과 같음) */
export const LEGAL_INFO_MAX_LENGTH: Record<LegalInfoField, number> = {
  representativeName: 40,
  businessNumber: 12,
  address: 200,
  contactEmail: 120,
  privacyEffectiveDate: 10,
  termsEffectiveDate: 10,
};

export const BUSINESS_NUMBER_PATTERN = /^[0-9]{3}-[0-9]{2}-[0-9]{5}$/;
export const CONTACT_EMAIL_PATTERN = /^[^@\s]+@[^@\s]+[.][^@\s]+$/;
export const EFFECTIVE_DATE_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

/** Firestore 문서(없으면 null) → 모든 칸이 문자열인 값. 문자열이 아니면 빈 값 */
export function normalizeLegalInfo(raw: unknown): LegalInfo {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...EMPTY_LEGAL_INFO };
  for (const k of LEGAL_INFO_FIELDS) {
    const v = r[k];
    out[k] = typeof v === "string" ? v.trim() : "";
  }
  return out;
}

/** 숫자 10자리면 `000-00-00000`으로, 아니면 다듬기만(검사에서 걸림) */
export function formatBusinessNumber(input: string): string {
  const digits = input.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
  return input.trim();
}

/** `YYYY-MM-DD`이고 실제 있는 날짜인지 */
export function isValidEffectiveDate(v: string): boolean {
  if (!EFFECTIVE_DATE_PATTERN.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** `2026-12-01` → `2026년 12월 1일`, 형식이 아니면 "" */
export function formatEffectiveDate(v: string): string {
  if (!isValidEffectiveDate(v)) return "";
  const [y, m, d] = v.split("-").map(Number);
  return `${y}년 ${m}월 ${d}일`;
}

/** 관리자 입력 검사 — 칸별 오류 문구(빈 값은 허용: "아직 입력 안 함") */
export function validateLegalInfoInput(info: LegalInfo): Partial<Record<LegalInfoField, string>> {
  const errors: Partial<Record<LegalInfoField, string>> = {};
  for (const k of LEGAL_INFO_FIELDS) {
    if (info[k].length > LEGAL_INFO_MAX_LENGTH[k]) {
      errors[k] = `${LEGAL_INFO_MAX_LENGTH[k]}자 이하로 입력해 주세요.`;
    }
  }
  if (!errors.businessNumber && info.businessNumber && !BUSINESS_NUMBER_PATTERN.test(info.businessNumber)) {
    errors.businessNumber = "숫자 10자리(000-00-00000)로 입력해 주세요.";
  }
  if (!errors.contactEmail && info.contactEmail && !CONTACT_EMAIL_PATTERN.test(info.contactEmail)) {
    errors.contactEmail = "이메일 형식으로 입력해 주세요.";
  }
  for (const k of ["privacyEffectiveDate", "termsEffectiveDate"] as const) {
    if (!errors[k] && info[k] && !isValidEffectiveDate(info[k])) {
      errors[k] = "날짜(YYYY-MM-DD)를 선택해 주세요.";
    }
  }
  return errors;
}

/** 비어 있는 칸(관리자 경고용) */
export function missingLegalInfoFields(info: LegalInfo): LegalInfoField[] {
  return LEGAL_INFO_FIELDS.filter((k) => !info[k]);
}

export type LegalInfoStatus = "loading" | "ready" | "error";

export const LEGAL_INFO_PENDING_TEXT = "(준비 중)";
export const LEGAL_INFO_LOADING_TEXT = "…";

/** 보여 줄 연락 이메일 — 비어 있으면 기본값 */
export function displayContactEmail(info: LegalInfo): string {
  return info.contactEmail || DEFAULT_CONTACT_EMAIL;
}

/** 본문 토큰 자리에 넣을 글자 — 빈칸·undefined를 내보내지 않는다 */
export function legalTokenText(key: LegalInfoField, info: LegalInfo, status: LegalInfoStatus): string {
  if (key === "contactEmail") return displayContactEmail(info);
  if (status === "loading") return LEGAL_INFO_LOADING_TEXT;
  if (key === "privacyEffectiveDate" || key === "termsEffectiveDate") {
    return formatEffectiveDate(info[key]) || LEGAL_INFO_PENDING_TEXT;
  }
  return info[key] || LEGAL_INFO_PENDING_TEXT;
}

export function isLegalInfoField(key: string): key is LegalInfoField {
  return (LEGAL_INFO_FIELDS as readonly string[]).includes(key);
}

export type LegalTextPart = { kind: "text"; text: string } | { kind: "token"; key: LegalInfoField };

const TOKEN_RE = /\[\[([A-Za-z]+)\]\]/g;

/** 문단을 글자·토큰 조각으로 — 모르는 토큰은 글자 그대로(단위 테스트가 본문에 없음을 확인) */
export function splitLegalTokens(text: string): LegalTextPart[] {
  const parts: LegalTextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    if (!isLegalInfoField(m[1])) continue;
    if (at > last) parts.push({ kind: "text", text: text.slice(last, at) });
    parts.push({ kind: "token", key: m[1] });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

/** 토큰 키 목록(본문 검사용) */
export function legalTokenKeys(text: string): string[] {
  return [...text.matchAll(TOKEN_RE)].map((m) => m[1]);
}

/** 문단 전체를 글자로 채움(테스트·간단 표시용) */
export function fillLegalTokens(text: string, info: LegalInfo, status: LegalInfoStatus): string {
  return splitLegalTokens(text)
    .map((p) => (p.kind === "text" ? p.text : legalTokenText(p.key, info, status)))
    .join("");
}

/**
 * 하단 사업자 정보 항목(O3) — 상호·이메일은 항상, 대표·사업자등록번호·주소는 값이 있을 때만(빈 값은 뺀다, 기획 ①).
 */
export function businessInfoItems(info: LegalInfo): { key: string; text: string }[] {
  const items: { key: string; text: string }[] = [{ key: "name", text: `상호 ${BUSINESS_NAME}` }];
  if (info.representativeName) items.push({ key: "representativeName", text: `대표 ${info.representativeName}` });
  if (info.businessNumber) items.push({ key: "businessNumber", text: `사업자등록번호 ${info.businessNumber}` });
  if (info.address) items.push({ key: "address", text: `주소 ${info.address}` });
  items.push({ key: "contactEmail", text: `이메일 ${displayContactEmail(info)}` });
  return items;
}
