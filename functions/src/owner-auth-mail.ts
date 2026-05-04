import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as nodemailer from "nodemailer";
import { createShortAuthLink, getAppOrigin } from "./auth-short-links";

if (!admin.apps.length) {
  admin.initializeApp();
}

function isFunctionsEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true";
}

async function sendOwnerVerificationEmail(params: {
  to: string;
  displayName: string;
  verifyLink: string;
}): Promise<void> {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const from = process.env.SMTP_FROM?.trim() || user;

  const body = [
    `${params.displayName || "오너"}님, 안녕하세요.`,
    "",
    "attn. 서비스 이메일 인증을 완료해 주세요.",
    "",
    "인증 링크",
    params.verifyLink,
    "",
    "보안을 위해 링크 유효 시간 내에 인증을 완료해 주세요.",
    "",
    "감사합니다.",
  ].join("\n");

  if (!host || !from) {
    logger.warn("SMTP 미설정 — owner verify link는 로그에만 출력됩니다.", { to: params.to });
    logger.info("owner_verify_link", { to: params.to, verifyLink: params.verifyLink });
    if (!isFunctionsEmulator()) {
      throw new HttpsError(
        "failed-precondition",
        "인증 메일 발송을 위해 Functions 환경 변수 SMTP_HOST, SMTP_FROM 등을 설정해 주세요.",
      );
    }
    return;
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
  });

  await transporter.sendMail({
    from,
    to: params.to,
    subject: "[attn.] 이메일 인증 안내",
    text: body,
  });
}

/**
 * 오너 이메일 인증 메일(커스텀 SMTP) 재발송/초기발송
 * - Firebase 기본 메일 대신 짧은 링크(우리 발급 토큰)를 메일 본문에 제공합니다.
 */
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

  const continueUrl = `${getAppOrigin()}/verify-email`;
  const longVerifyLink = await admin.auth().generateEmailVerificationLink(email, {
    url: continueUrl,
    handleCodeInApp: false,
  });
  const shortVerifyLink = await createShortAuthLink({
    targetUrl: longVerifyLink,
    purpose: "owner_verify",
    uid,
    email,
  });

  await sendOwnerVerificationEmail({
    to: email,
    displayName: user.displayName ?? "",
    verifyLink: shortVerifyLink,
  });

  const out: { ok: true; shortVerifyLink?: string } = { ok: true };
  if (isFunctionsEmulator()) {
    out.shortVerifyLink = shortVerifyLink;
  }
  return out;
});
