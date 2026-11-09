/**
 * 스모크 공용 — 가입 QR 링크(2-K)를 Admin SDK로 바로 만든다(링크 관리 함수 자체는 signup-links.smoke.mjs가 확인).
 * 서버 `functions/src/lib/signup-links.ts`와 같은 모양: `signupLinks/{sha256(token)}` + `academies/{a}/secrets/signupLinks`.
 */
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";

export async function seedSignupToken(db, academyId, kind) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await db.doc(`signupLinks/${tokenHash}`).set({
    academyId,
    kind,
    enabled: true,
    createdByUid: "smoke",
    rate: { windowKey: "", count: 0, notifiedWindowKey: null },
  });
  await db.doc(`academies/${academyId}/secrets/signupLinks`).set({ [kind]: { token, tokenHash } }, { merge: true });
  return token;
}

/** 가입 동의 값(2-L) — 서버 `functions/src/lib/legal-docs.ts`의 지금 버전(빌드 결과에서 읽음) */
const requireCjs = createRequire(import.meta.url);
const { LEGAL_DOC_VERSIONS } = requireCjs("../../functions/lib/lib/legal-docs.js");
export const CONSENTS = { terms: LEGAL_DOC_VERSIONS.terms, privacy: LEGAL_DOC_VERSIONS.privacy };
