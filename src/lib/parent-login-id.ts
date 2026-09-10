import {
  getMemberLoginIdFormatError,
  normalizeMemberLoginId,
} from "./member-login-id";

export function normalizeParentLoginId(raw: string): string {
  return normalizeMemberLoginId(raw);
}

export function getParentLoginIdFormatError(loginId: string): string | null {
  return getMemberLoginIdFormatError(loginId);
}
