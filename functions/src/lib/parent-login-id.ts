import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { attnLoginIndexPath } from "./attn-id";
import {
  assertMemberLoginIdAvailable,
  normalizeMemberLoginId,
  validateMemberLoginIdFormat,
} from "./member-login-id";

/** Google 가입 시 로그인 ID = Gmail */
const PARENT_LOGIN_EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

export function normalizeParentLoginId(raw: string): string {
  return normalizeMemberLoginId(raw);
}

export function isParentLoginEmail(loginId: string): boolean {
  return loginId.includes("@");
}

export function normalizeParentLoginEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateParentLoginEmailFormat(email: string): void {
  const e = normalizeParentLoginEmail(email);
  if (!PARENT_LOGIN_EMAIL_RE.test(e)) {
    throw new HttpsError("invalid-argument", "올바른 Google 이메일 주소가 아닙니다.");
  }
}

export function validateParentLoginIdFormat(loginId: string): void {
  if (isParentLoginEmail(loginId)) {
    validateParentLoginEmailFormat(loginId);
    return;
  }
  validateMemberLoginIdFormat(loginId);
}

export async function assertParentLoginIdAvailable(
  db: admin.firestore.Firestore,
  loginId: string,
): Promise<string> {
  if (isParentLoginEmail(loginId)) {
    const normalized = normalizeParentLoginEmail(loginId);
    validateParentLoginEmailFormat(loginId);
    const snap = await db.doc(attnLoginIndexPath(normalized)).get();
    if (snap.exists) {
      throw new HttpsError("already-exists", "이미 사용 중인 로그인 ID입니다.");
    }
    return normalized;
  }
  return assertMemberLoginIdAvailable(db, loginId);
}

function assertGoogleAuthUser(user: admin.auth.UserRecord): string {
  const hasGoogle = user.providerData.some((p) => p.providerId === "google.com");
  if (!hasGoogle) {
    throw new HttpsError(
      "failed-precondition",
      "Google 계정으로 로그인한 뒤 다시 시도해 주세요.",
    );
  }
  const email = typeof user.email === "string" ? user.email.trim() : "";
  if (!email) {
    throw new HttpsError("failed-precondition", "Google 계정 이메일을 확인할 수 없습니다.");
  }
  return normalizeParentLoginEmail(email);
}

export async function resolveParentGoogleLoginId(
  uid: string,
): Promise<{ loginId: string; displayName: string }> {
  const user = await admin.auth().getUser(uid);
  const loginId = assertGoogleAuthUser(user);
  const displayName =
    typeof user.displayName === "string" && user.displayName.trim()
      ? user.displayName.trim()
      : "";
  return { loginId, displayName };
}
