import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  issueEmailVerificationOtpForUid,
  verifyEmailVerificationOtpForUid,
  type EmailVerificationPurpose,
} from "./lib/email-verification-otp";

/**
 * 원장 가입 이메일 인증 코드(6자리). 학부모 이메일 인증(purpose "parent")은 2-L에서 없어졌다 —
 * 학부모 가입은 휴대폰 번호 확인(OCTOMO)을 쓴다.
 */
function parsePurpose(raw: unknown): EmailVerificationPurpose {
  if (raw === "owner") return raw;
  throw new HttpsError("invalid-argument", "인증 대상이 올바르지 않습니다.");
}

/** 로그인·가입 후 — 6자리 인증 코드 이메일 발송 */
export const issueEmailVerificationOtp = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const uid = request.auth.uid;
  parsePurpose(request.data?.purpose);

  const user = await admin.auth().getUser(uid);
  if (user.emailVerified) {
    return { ok: true as const, alreadyVerified: true as const };
  }
  const email = user.email?.trim().toLowerCase();
  if (!email) {
    throw new HttpsError("failed-precondition", "이메일 계정이 아닙니다.");
  }
  const extra = await issueEmailVerificationOtpForUid({
    uid,
    email,
    displayName: user.displayName ?? "",
    purpose: "owner",
  });
  return { ok: true as const, ...extra };
});

/** 6자리 인증 코드 검증 — 원장 이메일 인증 완료 */
export const verifyEmailVerificationOtp = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const code =
    typeof request.data?.code === "string" ? request.data.code.trim() : "";
  const purpose = parsePurpose(request.data?.purpose);

  await verifyEmailVerificationOtpForUid({
    uid: request.auth.uid,
    codeRaw: code,
    purpose,
  });

  return { ok: true as const };
});
