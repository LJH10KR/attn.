import * as crypto from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";

/**
 * 로그인 ID 방식(선생님·학부모) 비밀번호 저장 — `academies/{id}/{staff|parents}/{uid}/secrets/login`.
 * 평문은 저장하지 않고 솔트 포함 scrypt 해시만 둔다. 파라미터를 해시와 함께 저장하므로
 * 나중에 비용을 올려도 기존 해시는 그대로 검증된다. 저장·검증은 반드시 이 파일의 함수만 쓸 것.
 *
 * 필드: `passwordHash`(본인이 정한 비밀번호) · `tempPasswordHash`(학원이 발급한 임시 비밀번호, 첫 로그인·변경 시 삭제)
 * 임시 비밀번호 원문은 발급·재발급 응답에서 한 번만 돌려주고 어디에도 남기지 않는다.
 */

export type PasswordHashRecord = {
  algo: "scrypt";
  N: number;
  r: number;
  p: number;
  keyLen: number;
  /** base64 */
  salt: string;
  /** base64 */
  hash: string;
};

/** 현재 기본값 — N=2^14, r=8 (약 16MB 메모리) */
const SCRYPT_DEFAULTS = { N: 16384, r: 8, p: 1, keyLen: 64 } as const;
const SALT_BYTES = 16;
/** 검증 시 저장된 파라미터 상한 — 조작된 문서로 과도한 연산을 시키지 못하게 */
const MAX_N = 1 << 20;

function scrypt(
  plain: string,
  salt: Buffer,
  params: { N: number; r: number; p: number; keyLen: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      plain.normalize("NFKC"),
      salt,
      params.keyLen,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(plain: string): Promise<PasswordHashRecord> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(plain, salt, SCRYPT_DEFAULTS);
  return {
    algo: "scrypt",
    ...SCRYPT_DEFAULTS,
    salt: salt.toString("base64"),
    hash: key.toString("base64"),
  };
}

function readRecord(raw: unknown): PasswordHashRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const isInt = (v: unknown, min: number, max: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
  if (
    r.algo !== "scrypt" ||
    !isInt(r.N, 2, MAX_N) ||
    ((r.N as number) & ((r.N as number) - 1)) !== 0 ||
    !isInt(r.r, 1, 32) ||
    !isInt(r.p, 1, 16) ||
    !isInt(r.keyLen, 16, 128) ||
    typeof r.salt !== "string" ||
    typeof r.hash !== "string"
  ) {
    return null;
  }
  return r as unknown as PasswordHashRecord;
}

/** 형식이 깨진 기록·불일치는 모두 false — 상수 시간 비교 */
export async function verifyPassword(plain: string, stored: unknown): Promise<boolean> {
  const record = readRecord(stored);
  if (!record || !plain) return false;
  const expected = Buffer.from(record.hash, "base64");
  if (expected.length !== record.keyLen) return false;
  const actual = await scrypt(plain, Buffer.from(record.salt, "base64"), record);
  return crypto.timingSafeEqual(actual, expected);
}

let dummyRecord: Promise<PasswordHashRecord> | null = null;

/**
 * 없는 로그인 ID에도 실제 검증과 같은 비용의 scrypt를 한 번 돌림 — 응답 시간으로 ID 존재 여부를 알 수 없게.
 * 결과는 항상 버린다.
 */
export async function simulatePasswordCheck(plain: string): Promise<void> {
  dummyRecord ??= hashPassword(crypto.randomBytes(16).toString("base64"));
  await verifyPassword(plain || "x", await dummyRecord);
}

/** secrets/login 문서 데이터 — 본인 비밀번호 또는 임시 비밀번호 중 하나와 맞으면 true */
export async function verifyLoginSecret(
  secret: FirebaseFirestore.DocumentData | undefined,
  plain: string,
): Promise<boolean> {
  if (!secret) return false;
  const [byPassword, byTemp] = await Promise.all([
    verifyPassword(plain, secret.passwordHash),
    verifyPassword(plain, secret.tempPasswordHash),
  ]);
  return byPassword || byTemp;
}

/** 로그인 ID 방식 비밀번호가 하나라도 있는지(Google 전용 계정 판별) */
export function hasLoginSecret(secret: FirebaseFirestore.DocumentData | undefined): boolean {
  return Boolean(readRecord(secret?.passwordHash) || readRecord(secret?.tempPasswordHash));
}

/** 본인 비밀번호 저장(첫 로그인·변경·자가 가입) — 임시 비밀번호는 지움. `set(..., {merge: true})`용 */
export async function passwordSecretFields(plain: string) {
  return {
    passwordHash: await hashPassword(plain),
    tempPasswordHash: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/** 임시 비밀번호 저장(발급·재발급) — 본인 비밀번호가 있던 계정이면 그것도 지워 임시 비밀번호로만 로그인 */
export async function tempPasswordSecretFields(plain: string) {
  return {
    tempPasswordHash: await hashPassword(plain),
    passwordHash: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}
