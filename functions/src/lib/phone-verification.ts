import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp, type Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { octomoPhoneKey } from "./octomo-phone-key";
import {
  OCTOMO_DAILY_CALL_LIMIT,
  OCTOMO_DAILY_CALL_LIMIT_PER_LINK,
  PHONE_CHECK_MIN_INTERVAL_MS,
  PHONE_CHECKS_PER_CODE,
  PHONE_CODES_PER_IP_PER_HOUR,
  PHONE_CODES_PER_PHONE_PER_DAY,
  PHONE_CODES_PER_PHONE_PER_HOUR,
  PHONE_CODES_PER_UID_PER_HOUR,
  PHONE_VERIFICATION_DOC_TTL_MS,
} from "./phone-verification-limits";

/**
 * 휴대폰 번호 확인 기반(2-L) — OCTOMO 조회 결과를 우리 서버가 한 번만 쓰게 만드는 부분.
 * - `phoneVerifications/{id}`: 서버가 만든 무작위 6자리 코드·번호·목적·만료(서버만, 클라이언트 접근 불가).
 * - 확인에 성공하면 코드를 소비(status verified)하고 "확인 증표" `{id}.{secret}`를 준다(서버엔 해시만).
 * - 가입·번호 변경 함수가 트랜잭션 안에서 증표를 **한 번만** 쓴다(`readPhoneProofInTx` → `markUsed`).
 * - 목적(purpose)을 나눠 2-M 아이디·비밀번호 찾기가 같은 기반을 다시 쓴다.
 */

export const PHONE_VERIFICATION_PURPOSES = [
  "parent_signup",
  "staff_signup",
  "phone_change",
  // 2-M(아이디·비밀번호 찾기) 예약 — 아직 발급하지 않음
  "find_login_id",
  "reset_password",
] as const;
export type PhoneVerificationPurpose = (typeof PHONE_VERIFICATION_PURPOSES)[number];

/** 2-L에서 발급하는 목적 */
export const ISSUABLE_PURPOSES: readonly PhoneVerificationPurpose[] = ["parent_signup", "staff_signup", "phone_change"];

export type PhoneVerificationScope =
  | { kind: "signup_link"; linkHash: string }
  | { kind: "account"; uid: string; academyId: string; role: "parent" | "teacher" };

export const MSG_PHONE_PROOF_INVALID = "번호 확인이 만료되었거나 올바르지 않습니다. 번호 확인을 다시 해 주세요.";
export const MSG_PHONE_PROOF_MISMATCH = "번호 확인을 마친 번호와 입력한 번호가 다릅니다. 번호 확인을 다시 해 주세요.";

export function isPhoneVerificationPurpose(raw: unknown): raw is PhoneVerificationPurpose {
  return typeof raw === "string" && (PHONE_VERIFICATION_PURPOSES as readonly string[]).includes(raw);
}

export { octomoPhoneKey };

/** 확인 코드 — 숫자 6자리(접두어 없음: iPhone이 직접 칠 때 첫 글자를 대문자로 바꾸는 문제 방지) */
export function newPhoneCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export function newVerificationId(): string {
  return crypto.randomBytes(20).toString("base64url");
}

const VERIFICATION_ID_RE = /^[A-Za-z0-9_-]{27}$/;
const PROOF_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

export function isVerificationId(raw: unknown): raw is string {
  return typeof raw === "string" && VERIFICATION_ID_RE.test(raw);
}

export function hashProofSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

/** 증표 만들기 — 화면에는 `{id}.{secret}`, 서버엔 secret 해시만 */
export function newPhoneProof(verificationId: string): { proof: string; proofHash: string } {
  const secret = crypto.randomBytes(32).toString("base64url");
  return { proof: `${verificationId}.${secret}`, proofHash: hashProofSecret(secret) };
}

export function parsePhoneProof(raw: unknown): { verificationId: string; secret: string } | null {
  if (typeof raw !== "string") return null;
  const [id, secret, ...rest] = raw.trim().split(".");
  if (rest.length > 0 || !isVerificationId(id) || !secret || !PROOF_SECRET_RE.test(secret)) return null;
  return { verificationId: id, secret };
}

/** 서울 날짜 `YYYYMMDD` */
export function seoulDayKey(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** 서울 시각 `YYYYMMDDHH` */
export function seoulHourKeyOf(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${seoulDayKey(ms)}${p(d.getUTCHours())}`;
}

/** 서울 날짜가 끝나는 시각(다음 날 0시, ms) — 429를 받으면 그때까지 OCTOMO를 부르지 않는다 */
export function seoulDayEndMs(ms: number): number {
  const kst = ms + 9 * 60 * 60 * 1000;
  const dayStartKst = Math.floor(kst / 86_400_000) * 86_400_000;
  return dayStartKst + 86_400_000 - 9 * 60 * 60 * 1000;
}

/** OCTOMO `withinMinutes` — 코드를 만든 뒤 지난 분 + 1(1~60) */
export function withinMinutesFor(createdAtMs: number, nowMs: number): number {
  const elapsed = Math.max(0, nowMs - createdAtMs);
  return Math.min(60, Math.max(1, Math.ceil(elapsed / 60_000) + 1));
}

/** 보조 제한 키에 쓰는 해시(IP 원문을 남기지 않음) */
export function shortHash(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

export function counterKeys(params: {
  nowMs: number;
  phoneKey: string;
  ipHash: string | null;
  uid: string | null;
  linkHash: string | null;
}) {
  const day = seoulDayKey(params.nowMs);
  const hour = seoulHourKeyOf(params.nowMs);
  return {
    octomoDay: `octomo_day_${day}`,
    linkDay: params.linkHash ? `link_day_${params.linkHash}_${day}` : null,
    phoneHour: `phone_hr_${params.phoneKey}_${hour}`,
    phoneDay: `phone_day_${params.phoneKey}_${day}`,
    ipHour: params.ipHash ? `ip_hr_${params.ipHash}_${hour}` : null,
    uidHour: params.uid ? `uid_hr_${params.uid}_${hour}` : null,
  };
}

export function readCount(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** 오늘 OCTOMO를 더 부를 수 있는지 — 서비스 전체·링크별 한도와 429 차단 */
export function octomoBudgetAvailable(params: {
  globalCount: number;
  globalBlockedUntilMs: number | null;
  linkCount: number | null;
  nowMs: number;
}): boolean {
  if (params.globalBlockedUntilMs !== null && params.globalBlockedUntilMs > params.nowMs) return false;
  if (params.globalCount >= OCTOMO_DAILY_CALL_LIMIT) return false;
  if (params.linkCount !== null && params.linkCount >= OCTOMO_DAILY_CALL_LIMIT_PER_LINK) return false;
  return true;
}

/** 코드 발급 보조 제한 — 번호별·IP별·계정별 */
export function issueLimitsOk(c: {
  phoneHour: number;
  phoneDay: number;
  ipHour: number | null;
  uidHour: number | null;
}): boolean {
  if (c.phoneHour >= PHONE_CODES_PER_PHONE_PER_HOUR) return false;
  if (c.phoneDay >= PHONE_CODES_PER_PHONE_PER_DAY) return false;
  if (c.ipHour !== null && c.ipHour >= PHONE_CODES_PER_IP_PER_HOUR) return false;
  if (c.uidHour !== null && c.uidHour >= PHONE_CODES_PER_UID_PER_HOUR) return false;
  return true;
}

export type CheckGate =
  | { ok: true }
  | { ok: false; status: "expired" | "exhausted" | "already_verified" }
  | { ok: false; status: "too_soon"; retryAfterMs: number };

/** 이번 조회를 OCTOMO로 보내도 되는지(코드 상태만 — 한도는 `octomoBudgetAvailable`) */
export function decideCheckGate(v: {
  status: unknown;
  expiresAtMs: number;
  checkCount: number;
  lastCheckAtMs: number | null;
  nowMs: number;
}): CheckGate {
  if (v.status === "verified") return { ok: false, status: "already_verified" };
  if (v.status !== "pending") return { ok: false, status: "exhausted" };
  if (v.nowMs >= v.expiresAtMs) return { ok: false, status: "expired" };
  if (v.checkCount >= PHONE_CHECKS_PER_CODE) return { ok: false, status: "exhausted" };
  if (v.lastCheckAtMs !== null && v.nowMs - v.lastCheckAtMs < PHONE_CHECK_MIN_INTERVAL_MS) {
    return { ok: false, status: "too_soon", retryAfterMs: PHONE_CHECK_MIN_INTERVAL_MS - (v.nowMs - v.lastCheckAtMs) };
  }
  return { ok: true };
}

export function phoneVerificationRef(db: admin.firestore.Firestore, id: string) {
  return db.doc(`phoneVerifications/${id}`);
}

export function phoneCounterRef(db: admin.firestore.Firestore, key: string) {
  return db.doc(`phoneVerificationCounters/${key}`);
}

export function counterTtl(nowMs: number): Timestamp {
  return Timestamp.fromMillis(nowMs + PHONE_VERIFICATION_DOC_TTL_MS + 24 * 60 * 60 * 1000);
}

function millisOf(raw: unknown): number | null {
  return raw instanceof Timestamp ? raw.toMillis() : null;
}

export type PhoneProofExpectation = {
  purposes: readonly PhoneVerificationPurpose[];
  /** 요청한 번호(010 11자리 키) */
  phoneKey: string;
  /** 가입 — 같은 가입 링크로 확인한 증표만 */
  linkHash?: string;
  /** 번호 변경 — 같은 계정이 확인한 증표만 */
  uid?: string;
};

/**
 * 트랜잭션 안에서 증표 확인(읽기 단계에서 부를 것). 반환된 `markUsed`는 쓰기 단계에서 호출한다.
 * 형식·없음·미확인·만료·이미 씀·목적·scope가 다르면 `MSG_PHONE_PROOF_INVALID`, 번호가 다르면 `MSG_PHONE_PROOF_MISMATCH`.
 */
export async function readPhoneProofInTx(
  tx: Transaction,
  db: admin.firestore.Firestore,
  rawProof: unknown,
  expect: PhoneProofExpectation,
  nowMs: number = Date.now(),
): Promise<{ phoneKey: string; markUsed: (usedByUid: string) => void }> {
  const parsed = parsePhoneProof(rawProof);
  if (!parsed) throw new HttpsError("failed-precondition", MSG_PHONE_PROOF_INVALID);
  const ref = phoneVerificationRef(db, parsed.verificationId);
  const snap = await tx.get(ref);
  const proofExpiresAt = millisOf(snap.get("proofExpiresAt"));
  const scope = snap.get("scope") as Record<string, unknown> | undefined;
  const valid =
    snap.exists &&
    snap.get("status") === "verified" &&
    snap.get("usedAt") == null &&
    typeof snap.get("proofHash") === "string" &&
    snap.get("proofHash") === hashProofSecret(parsed.secret) &&
    proofExpiresAt !== null &&
    proofExpiresAt > nowMs &&
    expect.purposes.includes(snap.get("purpose")) &&
    (expect.linkHash === undefined || scope?.linkHash === expect.linkHash) &&
    (expect.uid === undefined || scope?.uid === expect.uid);
  if (!valid) throw new HttpsError("failed-precondition", MSG_PHONE_PROOF_INVALID);
  const phoneKey = snap.get("phoneKey");
  if (typeof phoneKey !== "string" || phoneKey !== expect.phoneKey) {
    throw new HttpsError("failed-precondition", MSG_PHONE_PROOF_MISMATCH);
  }
  return {
    phoneKey,
    markUsed: (usedByUid: string) => {
      tx.update(ref, { usedAt: FieldValue.serverTimestamp(), usedByUid });
    },
  };
}

/** 계정 문서에 쓰는 "확인된 번호" 필드 */
export function verifiedPhoneFields(phoneKey: string): { phoneVerifiedKey: string; phoneVerifiedAt: FieldValue } {
  return { phoneVerifiedKey: phoneKey, phoneVerifiedAt: FieldValue.serverTimestamp() };
}

/** 계정의 번호가 지금 문자로 확인된 번호인지 */
export function isAccountPhoneVerified(data: { phone?: unknown; phoneVerifiedKey?: unknown }): boolean {
  const key = octomoPhoneKey(typeof data.phone === "string" ? data.phone : "");
  return key !== "" && data.phoneVerifiedKey === key;
}
