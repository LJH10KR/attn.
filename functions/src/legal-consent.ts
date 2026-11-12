import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { hasCurrentConsents, LEGAL_DOC_VERSIONS, parseRequiredConsents } from "./lib/legal-docs";

/**
 * 원장 동의 기록(2-L) — `legalConsents/{uid}`(서버만, 클라이언트 접근 불가).
 * 원장 계정 문서 `users/{uid}`는 본인이 직접 쓸 수 있어 동의 근거로 쓰지 않는다.
 * 학부모·직원 동의는 가입 함수가 계정 문서 `consents`에 같은 트랜잭션으로 쓴다.
 * 원장 화면(/owner·/academy)은 들어올 때 `getOwnerConsentState`로 지금 버전 동의가 있는지 보고,
 * 없으면(가입 직후 기록 실패·문서 개정) 동의 시트를 다시 띄워 `recordOwnerConsent`를 부른다.
 */

function requireUid(request: { auth?: { uid: string } }): string {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  return uid;
}

/** 지금 버전 동의가 있는지(가벼운 읽기 1건) */
export const getOwnerConsentState = onCall(async (request) => {
  const uid = requireUid(request);
  const snap = await admin.firestore().doc(`legalConsents/${uid}`).get();
  return {
    ok: true as const,
    current: hasCurrentConsents(snap.get("consents")),
    versions: LEGAL_DOC_VERSIONS,
  };
});

/** 원장 동의 기록 — 이용약관·개인정보 수집·이용 둘 다 지금 버전 */
export const recordOwnerConsent = onCall(async (request) => {
  const uid = requireUid(request);
  const consents = parseRequiredConsents(request.data?.consents);
  await admin.firestore().doc(`legalConsents/${uid}`).set(
    { uid, role: "owner", consents, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return { ok: true as const };
});
