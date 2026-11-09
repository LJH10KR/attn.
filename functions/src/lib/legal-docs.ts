import { FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

/**
 * 이용약관·개인정보 처리방침 문서 버전(2-L) — 화면 `src/lib/legal/legal-docs.ts`와 같은 값(단위 테스트가 비교).
 * 본문이 확정·개정되면 두 파일의 버전을 함께 올린다 → 원장은 다음 진입 때 다시 동의, 새 가입자는 새 버전으로 기록.
 */
export const LEGAL_DOC_VERSIONS = {
  terms: "2026-11-draft",
  privacy: "2026-11-draft",
} as const;

export type LegalDocKind = keyof typeof LEGAL_DOC_VERSIONS;

export const MSG_CONSENT_REQUIRED = "이용약관과 개인정보 수집·이용에 동의해 주세요.";
export const MSG_CONSENT_OUTDATED = "약관이 바뀌었습니다. 페이지를 새로고침한 뒤 다시 동의해 주세요.";

/**
 * 가입 요청의 동의 `{ terms: 버전, privacy: 버전 }` — 둘 다 지금 버전이어야 한다.
 * 저장 형식 `{ terms: { version, agreedAt }, privacy: { version, agreedAt } }`.
 */
export function parseRequiredConsents(raw: unknown): {
  terms: { version: string; agreedAt: FieldValue };
  privacy: { version: string; agreedAt: FieldValue };
} {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!r || typeof r.terms !== "string" || typeof r.privacy !== "string" || !r.terms || !r.privacy) {
    throw new HttpsError("invalid-argument", MSG_CONSENT_REQUIRED);
  }
  if (r.terms !== LEGAL_DOC_VERSIONS.terms || r.privacy !== LEGAL_DOC_VERSIONS.privacy) {
    throw new HttpsError("failed-precondition", MSG_CONSENT_OUTDATED);
  }
  return {
    terms: { version: LEGAL_DOC_VERSIONS.terms, agreedAt: FieldValue.serverTimestamp() },
    privacy: { version: LEGAL_DOC_VERSIONS.privacy, agreedAt: FieldValue.serverTimestamp() },
  };
}

/** 저장된 동의가 지금 버전인지 */
export function hasCurrentConsents(raw: unknown): boolean {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const v = (k: LegalDocKind) => {
    const e = r?.[k];
    return e && typeof e === "object" ? (e as Record<string, unknown>).version : undefined;
  };
  return v("terms") === LEGAL_DOC_VERSIONS.terms && v("privacy") === LEGAL_DOC_VERSIONS.privacy;
}
