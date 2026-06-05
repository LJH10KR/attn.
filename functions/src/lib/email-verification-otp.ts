import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as nodemailer from "nodemailer";

export type EmailVerificationPurpose = "owner" | "parent";

const OTP_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

export function normalizeContactEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function assertContactEmail(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new HttpsError("invalid-argument", "이메일을 입력해 주세요.");
  }
  const email = normalizeContactEmail(raw);
  if (!EMAIL_RE.test(email)) {
    throw new HttpsError("invalid-argument", "이메일 형식을 확인해 주세요.");
  }
  return email;
}

function otpDocPath(uid: string): string {
  return `emailVerificationOtps/${uid}`;
}

function hashOtp(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function generateOtpCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function isFunctionsEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true";
}

async function sendOtpEmail(params: {
  to: string;
  displayName: string;
  code: string;
  purpose: EmailVerificationPurpose;
}): Promise<void> {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const from = process.env.SMTP_FROM?.trim() || user;

  const roleLabel = params.purpose === "owner" ? "오너" : "학부모";
  const body = [
    `${params.displayName || "회원"}님, 안녕하세요.`,
    "",
    `attn. ${roleLabel} 이메일 인증 코드입니다.`,
    "",
    `인증 코드: ${params.code}`,
    "",
    "코드는 15분 동안 유효합니다. 로그인 화면에서 입력해 주세요.",
    "",
    "감사합니다.",
  ].join("\n");

  if (!host || !from) {
    logger.warn("SMTP 미설정 — OTP는 로그에만 출력됩니다.", { to: params.to });
    logger.info("email_verification_otp", {
      to: params.to,
      code: params.code,
      purpose: params.purpose,
    });
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
    subject: "[attn.] 이메일 인증 코드",
    text: body,
  });
}

export async function issueEmailVerificationOtpForUid(params: {
  uid: string;
  email: string;
  displayName: string;
  purpose: EmailVerificationPurpose;
}): Promise<{ debugCode?: string }> {
  const db = admin.firestore();
  const ref = db.doc(otpDocPath(params.uid));
  const existing = await ref.get();
  const lastSentAt = existing.get("lastSentAt") as Timestamp | undefined;
  if (lastSentAt && Date.now() - lastSentAt.toMillis() < RESEND_COOLDOWN_MS) {
    throw new HttpsError(
      "resource-exhausted",
      "인증 코드를 방금 발송했습니다. 잠시 후 다시 시도해 주세요.",
    );
  }

  const code = generateOtpCode();
  await ref.set({
    codeHash: hashOtp(code),
    email: params.email,
    purpose: params.purpose,
    attempts: 0,
    lastSentAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + OTP_TTL_MS),
    createdAt: FieldValue.serverTimestamp(),
  });

  await sendOtpEmail({
    to: params.email,
    displayName: params.displayName,
    code,
    purpose: params.purpose,
  });

  return isFunctionsEmulator() ? { debugCode: code } : {};
}

export async function verifyEmailVerificationOtpForUid(params: {
  uid: string;
  codeRaw: string;
  purpose: EmailVerificationPurpose;
}): Promise<void> {
  const code = params.codeRaw.trim();
  if (!/^\d{6}$/.test(code)) {
    throw new HttpsError("invalid-argument", "6자리 인증 코드를 입력해 주세요.");
  }

  const db = admin.firestore();
  const ref = db.doc(otpDocPath(params.uid));
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "인증 코드가 없거나 만료되었습니다. 다시 발송해 주세요.");
  }

  const storedPurpose = snap.get("purpose");
  if (storedPurpose !== params.purpose) {
    throw new HttpsError("failed-precondition", "인증 요청이 올바르지 않습니다.");
  }

  const expiresAt = snap.get("expiresAt") as Timestamp | undefined;
  if (!expiresAt || expiresAt.toMillis() < Date.now()) {
    await ref.delete();
    throw new HttpsError("deadline-exceeded", "인증 코드가 만료되었습니다. 다시 발송해 주세요.");
  }

  const attempts = (snap.get("attempts") as number) || 0;
  if (attempts >= MAX_ATTEMPTS) {
    await ref.delete();
    throw new HttpsError(
      "resource-exhausted",
      "인증 시도 횟수를 초과했습니다. 코드를 다시 발송해 주세요.",
    );
  }

  const codeHash = snap.get("codeHash");
  if (typeof codeHash !== "string" || codeHash !== hashOtp(code)) {
    await ref.update({ attempts: attempts + 1 });
    throw new HttpsError("permission-denied", "인증 코드가 올바르지 않습니다.");
  }

  if (params.purpose === "owner") {
    await admin.auth().updateUser(params.uid, { emailVerified: true });
    await db.doc(`users/${params.uid}`).set(
      {
        emailVerified: true,
        ownerOnboardedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } else {
    const parentSnaps = await db
      .collectionGroup("parents")
      .where("authUid", "==", params.uid)
      .where("status", "==", "pending_email_verification")
      .limit(5)
      .get();

    if (parentSnaps.empty) {
      throw new HttpsError("failed-precondition", "이메일 인증이 필요한 학부모 계정을 찾을 수 없습니다.");
    }

    const memberDoc = parentSnaps.docs[0]!;
    const academyId = memberDoc.ref.parent.parent?.id;
    if (!academyId) {
      throw new HttpsError("failed-precondition", "학원 정보를 찾을 수 없습니다.");
    }
    await memberDoc.ref.update({
      status: "active",
      contactEmailVerified: true,
      activatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await admin.auth().setCustomUserClaims(params.uid, {
      role: "parent",
      academyId,
      membershipStatus: "active",
    });
  }

  await ref.delete();
}
