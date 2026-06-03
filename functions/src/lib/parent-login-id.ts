import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { attnLoginIndexPath } from "./attn-id";

/** 학부모 자가 설정 로그인 ID — 전역 유일, 소문자 저장 */
const PARENT_LOGIN_ID_RE = /^[a-z][a-z0-9_]{3,19}$/;

const RESERVED = new Set([
  "admin",
  "owner",
  "teacher",
  "parent",
  "academy",
  "student",
  "attn",
  "login",
  "signup",
  "support",
  "help",
  "system",
  "root",
  "null",
  "undefined",
]);

/** attn. 발급 번호와 혼동 방지 */
const ATTN_LIKE_RE = /^\d{5}_\d{2}(_\d+)?$/;

export function normalizeParentLoginId(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateParentLoginIdFormat(loginId: string): void {
  const id = normalizeParentLoginId(loginId);
  if (!PARENT_LOGIN_ID_RE.test(id)) {
    throw new HttpsError(
      "invalid-argument",
      "로그인 ID는 영문 소문자로 시작하고, 4~20자의 영문·숫자·밑줄(_)만 사용할 수 있습니다.",
    );
  }
  if (RESERVED.has(id)) {
    throw new HttpsError("invalid-argument", "사용할 수 없는 로그인 ID입니다.");
  }
  if (ATTN_LIKE_RE.test(id)) {
    throw new HttpsError(
      "invalid-argument",
      "시스템 발급 번호 형식은 로그인 ID로 사용할 수 없습니다.",
    );
  }
}

export async function assertParentLoginIdAvailable(
  db: admin.firestore.Firestore,
  loginId: string,
): Promise<string> {
  const normalized = normalizeParentLoginId(loginId);
  validateParentLoginIdFormat(loginId);
  const snap = await db.doc(attnLoginIndexPath(normalized)).get();
  if (snap.exists) {
    throw new HttpsError("already-exists", "이미 사용 중인 로그인 ID입니다.");
  }
  return normalized;
}
