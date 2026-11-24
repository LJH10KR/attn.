import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as nodemailer from "nodemailer";
import {
  hashOtp,
  issueOtpWith,
  OtpCooldownError,
  type IssueMode,
  type OtpStore,
} from "./email-verification-issue";
import { OTP_MAX_ATTEMPTS } from "./email-verification-policy";

/** 원장 가입 이메일 인증만(2-L — 학부모 이메일 인증은 휴대폰 번호 확인으로 대체돼 없어짐) */
export type EmailVerificationPurpose = "owner";

function otpDocPath(uid: string): string {
  return `emailVerificationOtps/${uid}`;
}

function isFunctionsEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true";
}

async function sendOtpEmail(params: {
  uid: string;
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

  const roleLabel = "오너";
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
    if (!isFunctionsEmulator()) {
      // 운영 로그에는 이메일·코드를 남기지 않는다(3-A 후속 B2)
      logger.error("SMTP 미설정 — 인증 메일을 보내지 못했습니다.", {
        uid: params.uid,
        purpose: params.purpose,
      });
      throw new HttpsError(
        "failed-precondition",
        "인증 메일 발송을 위해 Functions 환경 변수 SMTP_HOST, SMTP_FROM 등을 설정해 주세요.",
      );
    }
    // 에뮬레이터만 — 코드를 로그로 확인(QA용)
    logger.info("email_verification_otp", {
      to: params.to,
      code: params.code,
      purpose: params.purpose,
    });
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

function firestoreOtpStore(uid: string, purpose: EmailVerificationPurpose): OtpStore {
  const db = admin.firestore();
  const ref = db.doc(otpDocPath(uid));
  const millis = (v: unknown): number | null =>
    v instanceof Timestamp ? v.toMillis() : null;
  return {
    async get() {
      const snap = await ref.get();
      if (!snap.exists) return null;
      return {
        codeHash: snap.get("codeHash"),
        email: snap.get("email"),
        attempts: snap.get("attempts"),
        // 메일이 실제로 나간 시각만 본다(B1). 이 [Fix] 전 문서(deliveredAt 없음)는 보내지 않은 것으로 본다.
        deliveredAtMs: millis(snap.get("deliveredAt")),
        expiresAtMs: millis(snap.get("expiresAt")),
      };
    },
    async replace(doc) {
      await ref.set({
        codeHash: doc.codeHash,
        email: doc.email,
        purpose,
        attempts: 0,
        expiresAt: Timestamp.fromMillis(doc.expiresAtMs),
        createdAt: FieldValue.serverTimestamp(),
      });
    },
    async markDelivered(atMs) {
      const at = Timestamp.fromMillis(atMs);
      await ref.update({ deliveredAt: at, lastSentAt: at });
    },
    async deleteIfCodeHash(codeHash) {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists && snap.get("codeHash") === codeHash) tx.delete(ref);
      });
    },
  };
}

export type IssueEmailVerificationOtpResult =
  | { sent: true; debugCode?: string }
  | { sent: false; reason: "recent" | "cooldown" };

export async function issueEmailVerificationOtpForUid(params: {
  uid: string;
  email: string;
  displayName: string;
  purpose: EmailVerificationPurpose;
  /** 기본 "resend"(늘 새 코드). 인증 창이 열릴 때는 "auto"(최근 보낸 유효 코드가 있으면 건너뜀) */
  mode?: IssueMode;
}): Promise<IssueEmailVerificationOtpResult> {
  let result;
  try {
    result = await issueOtpWith(
      {
        store: firestoreOtpStore(params.uid, params.purpose),
        send: (code) =>
          sendOtpEmail({
            uid: params.uid,
            to: params.email,
            displayName: params.displayName,
            code,
            purpose: params.purpose,
          }),
      },
      { email: params.email, mode: params.mode ?? "resend" },
    );
  } catch (e) {
    if (e instanceof OtpCooldownError) {
      throw new HttpsError(
        "resource-exhausted",
        "인증 코드를 방금 발송했습니다. 잠시 후 다시 시도해 주세요.",
      );
    }
    if (e instanceof HttpsError) throw e;
    logger.error("email_verification_send_failed", {
      uid: params.uid,
      purpose: params.purpose,
      error: e instanceof Error ? e.message : String(e),
    });
    throw new HttpsError("unavailable", "인증 메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
  if (!result.sent) return result;
  return isFunctionsEmulator() ? { sent: true, debugCode: result.code } : { sent: true };
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
  if (attempts >= OTP_MAX_ATTEMPTS) {
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

  await admin.auth().updateUser(params.uid, { emailVerified: true });
  await db.doc(`users/${params.uid}`).set(
    {
      emailVerified: true,
      ownerOnboardedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await ref.delete();
}
