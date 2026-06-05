import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { issueEmailVerificationOtpForUid } from "./lib/email-verification-otp";

if (!admin.apps.length) {
  admin.initializeApp();
}

/** 오너 이메일 인증 코드 발송(재발송 포함) */
export const sendOwnerSignupVerificationEmail = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }

  const user = await admin.auth().getUser(uid);
  const email = user.email?.trim().toLowerCase();
  if (!email) {
    throw new HttpsError("failed-precondition", "이메일 계정이 아닙니다.");
  }
  if (user.emailVerified) {
    return { ok: true as const, alreadyVerified: true as const };
  }

  const extra = await issueEmailVerificationOtpForUid({
    uid,
    email,
    displayName: user.displayName ?? "",
    purpose: "owner",
  });

  return { ok: true as const, ...extra };
});
