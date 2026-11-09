/**
 * 스모크 공용 — 가입 QR 링크(2-K)를 Admin SDK로 바로 만든다(링크 관리 함수 자체는 signup-links.smoke.mjs가 확인).
 * 서버 `functions/src/lib/signup-links.ts`와 같은 모양: `signupLinks/{sha256(token)}` + `academies/{a}/secrets/signupLinks`.
 */
import { createHash, randomBytes } from "node:crypto";

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
