import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { googleEmailVerificationDecision } from "./lib/email-verification-policy";

/**
 * 3-A 후속 F2 — 연결된 Google 계정의 이메일이 계정 이메일과 같으면 Auth `emailVerified`를 true로.
 * Google이 그 이메일 소유를 이미 확인했으므로 인증 코드 창 없이 진행한다.
 * - 클라이언트 값은 받지 않는다: Admin `getUser(uid)`의 providerData(google.com) email == 계정 email일 때만.
 * - 로그인 ID 계정 내부 이메일(@provision.attndot.internal)은 대상 아님.
 * - `users` 문서는 쓰지 않는다(원장이 아닌 사람이 불러도 ownerOnboardedAt이 생기지 않게) — 원장 화면이
 *   reload·토큰 갱신 뒤 `upsertOwnerProfile`로 맞춘다.
 * - 로그에 이메일 원문을 남기지 않는다(uid·판단 결과만).
 */
export const confirmGoogleEmailVerified = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const user = await admin.auth().getUser(uid);
  const decision = googleEmailVerificationDecision(user);
  if (decision === "verify") {
    await admin.auth().updateUser(uid, { emailVerified: true });
  }
  logger.info("confirm_google_email_verified", { uid, decision });
  return { verified: decision === "verify" || decision === "already" };
});
