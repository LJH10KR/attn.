import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  issueEmailVerificationOtpForUid,
  verifyEmailVerificationOtpForUid,
  type EmailVerificationPurpose,
} from "./lib/email-verification-otp";

function parsePurpose(raw: unknown): EmailVerificationPurpose {
  if (raw === "owner" || raw === "parent") return raw;
  throw new HttpsError("invalid-argument", "인증 대상이 올바르지 않습니다.");
}

async function resolveParentContactEmail(uid: string): Promise<{
  email: string;
  displayName: string;
}> {
  const snaps = await admin
    .firestore()
    .collectionGroup("parents")
    .where("authUid", "==", uid)
    .limit(5)
    .get();

  for (const doc of snaps.docs) {
    const status = doc.get("status");
    if (status !== "pending_email_verification") continue;
    const email =
      typeof doc.get("contactEmail") === "string" ? doc.get("contactEmail").trim() : "";
    if (!email) continue;
    const displayName =
      typeof doc.get("displayName") === "string" ? doc.get("displayName") : "";
    return { email, displayName };
  }

  throw new HttpsError("failed-precondition", "이메일 인증이 필요한 학부모 계정을 찾을 수 없습니다.");
}

/** 로그인·가입 후 — 6자리 인증 코드 이메일 발송 */
export const issueEmailVerificationOtp = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const uid = request.auth.uid;
  const purpose = parsePurpose(request.data?.purpose);

  if (purpose === "owner") {
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
  }

  const { email, displayName } = await resolveParentContactEmail(uid);
  const extra = await issueEmailVerificationOtpForUid({
    uid,
    email,
    displayName,
    purpose: "parent",
  });
  return { ok: true as const, ...extra };
});

/** 6자리 인증 코드 검증 — 계정 활성화 */
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
