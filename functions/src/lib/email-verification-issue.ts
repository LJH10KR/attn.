import * as crypto from "node:crypto";
import {
  decideAutoIssue,
  OTP_TTL_MS,
  RESEND_COOLDOWN_MS,
} from "./email-verification-policy";

/**
 * 인증 코드 발급 흐름(저장소·메일 발송을 주입받음 — 단위 테스트용). Firestore·nodemailer 연결은
 * `email-verification-otp.ts`.
 *
 * - 코드 문서를 먼저 저장하고 메일을 보낸 뒤, **보내기에 성공해야** `deliveredAt`을 남긴다.
 *   보내기에 실패하면 방금 저장한 코드 문서를 지운다 → 자동 발송 recent·cooldown, [다시 받기] 60초 제한에
 *   걸리지 않고 바로 다시 시도할 수 있다(3-A 후속 B1).
 * - mode "auto"(인증 창이 열릴 때): 최근 보낸 유효 코드가 있으면 새로 만들지 않고 `{ sent: false, reason }`.
 * - mode "resend"([다시 받기]·가입 직후): 늘 새 코드(앞 코드 무효). 60초 안이면 cooldown 오류.
 */

export type IssueMode = "auto" | "resend";

export type StoredOtp = {
  codeHash?: unknown;
  email?: unknown;
  attempts?: unknown;
  deliveredAtMs: number | null;
  expiresAtMs: number | null;
};

export type NewOtpDoc = {
  codeHash: string;
  email: string;
  expiresAtMs: number;
};

export type OtpStore = {
  get(): Promise<StoredOtp | null>;
  /** 새 코드 문서로 통째 교체(attempts 0, deliveredAt 없음) */
  replace(doc: NewOtpDoc): Promise<void>;
  /** 보내기 성공 표시 */
  markDelivered(atMs: number): Promise<void>;
  /** codeHash가 아직 같을 때만 지움(그사이 다른 발급이 덮었으면 그대로) */
  deleteIfCodeHash(codeHash: string): Promise<void>;
};

export type IssueResult =
  | { sent: true; code: string }
  | { sent: false; reason: "recent" | "cooldown" };

export class OtpCooldownError extends Error {
  constructor() {
    super("cooldown");
    this.name = "OtpCooldownError";
  }
}

export function hashOtp(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export function generateOtpCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export async function issueOtpWith(
  deps: {
    store: OtpStore;
    send: (code: string) => Promise<void>;
    now?: () => number;
    generate?: () => string;
  },
  params: { email: string; mode: IssueMode },
): Promise<IssueResult> {
  const now = deps.now ?? Date.now;
  const existing = await deps.store.get();

  if (params.mode === "auto") {
    const decision = decideAutoIssue({
      now: now(),
      deliveredAtMs: existing?.deliveredAtMs ?? null,
      expiresAtMs: existing?.expiresAtMs ?? null,
      attempts: typeof existing?.attempts === "number" ? existing.attempts : 0,
      storedEmail: typeof existing?.email === "string" ? existing.email : null,
      email: params.email,
    });
    if (decision !== "send") return { sent: false, reason: decision };
  } else {
    const delivered = existing?.deliveredAtMs ?? null;
    if (delivered != null && now() - delivered < RESEND_COOLDOWN_MS) {
      throw new OtpCooldownError();
    }
  }

  const code = (deps.generate ?? generateOtpCode)();
  const codeHash = hashOtp(code);
  await deps.store.replace({
    codeHash,
    email: params.email,
    expiresAtMs: now() + OTP_TTL_MS,
  });
  try {
    await deps.send(code);
  } catch (e) {
    await deps.store.deleteIfCodeHash(codeHash).catch(() => undefined);
    throw e;
  }
  await deps.store.markDelivered(now());
  return { sent: true, code };
}
