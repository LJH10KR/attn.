import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { attnLoginIndexPath, isAttnIdLike } from "./attn-id";

/** 영문 별칭 — 학부모 수동 설정·레거시 */
export const MEMBER_LOGIN_ID_ASCII_RE = /^[a-z][a-z0-9_]{3,19}$/;

/** 한글 닉네임 — 선생님 자동 발급·수동 설정 (형용사+명사 등) */
export const MEMBER_LOGIN_ID_HANGUL_RE = /^[가-힣]{4,12}$/;

export const RESERVED_MEMBER_LOGIN_IDS = new Set([
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

/** attn. 발급 번호와 혼동 방지 — `isAttnIdLike` 사용 권장 */
export function isAttnLikeLoginId(loginId: string): boolean {
  return isAttnIdLike(loginId);
}

export function isHangulMemberLoginId(loginId: string): boolean {
  return MEMBER_LOGIN_ID_HANGUL_RE.test(loginId);
}

export function normalizeMemberLoginId(raw: string): string {
  const trimmed = raw.trim();
  if (MEMBER_LOGIN_ID_HANGUL_RE.test(trimmed)) {
    return trimmed;
  }
  return trimmed.toLowerCase();
}

export function validateMemberLoginIdFormat(loginId: string): void {
  const id = normalizeMemberLoginId(loginId);
  const asciiOk = MEMBER_LOGIN_ID_ASCII_RE.test(id);
  const hangulOk = MEMBER_LOGIN_ID_HANGUL_RE.test(id);
  if (!asciiOk && !hangulOk) {
    throw new HttpsError(
      "invalid-argument",
      "로그인 ID는 한글 4~12자(띄어쓰기 없음) 또는 영문 소문자로 시작하는 4~20자(영문·숫자·밑줄)여야 합니다.",
    );
  }
  if (!hangulOk && RESERVED_MEMBER_LOGIN_IDS.has(id)) {
    throw new HttpsError("invalid-argument", "사용할 수 없는 로그인 ID입니다.");
  }
  if (isAttnIdLike(id)) {
    throw new HttpsError(
      "invalid-argument",
      "시스템 발급 번호 형식은 로그인 ID로 사용할 수 없습니다.",
    );
  }
}

export async function assertMemberLoginIdAvailable(
  db: admin.firestore.Firestore,
  loginIdRaw: string,
  exceptAuthUid?: string,
): Promise<string> {
  const normalized = normalizeMemberLoginId(loginIdRaw);
  validateMemberLoginIdFormat(normalized);
  const snap = await db.doc(attnLoginIndexPath(normalized)).get();
  if (snap.exists) {
    const otherUid = snap.get("authUid");
    if (exceptAuthUid && otherUid === exceptAuthUid) {
      return normalized;
    }
    throw new HttpsError("already-exists", "이미 사용 중인 로그인 ID입니다.");
  }
  return normalized;
}
