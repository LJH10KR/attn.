/** 학부모 로그인 ID — 클라이언트 형식 검사(서버와 동일 규칙) */

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
]);

const ATTN_LIKE_RE = /^\d{5}_\d{2}(_\d+)?$/;

export function normalizeParentLoginId(raw: string): string {
  return raw.trim().toLowerCase();
}

export function getParentLoginIdFormatError(loginId: string): string | null {
  const id = normalizeParentLoginId(loginId);
  if (!id) {
    return "로그인 ID를 입력해 주세요.";
  }
  if (!PARENT_LOGIN_ID_RE.test(id)) {
    return "영문 소문자로 시작하고, 4~20자의 영문·숫자·밑줄(_)만 사용할 수 있습니다.";
  }
  if (RESERVED.has(id)) {
    return "사용할 수 없는 로그인 ID입니다.";
  }
  if (ATTN_LIKE_RE.test(id)) {
    return "시스템 발급 번호 형식은 사용할 수 없습니다.";
  }
  return null;
}
