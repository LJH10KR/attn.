/** 선생님·학부모 로그인 ID — 클라이언트 형식 검사(서버와 동일 규칙) */

const MEMBER_LOGIN_ID_ASCII_RE = /^[a-z][a-z0-9_]{3,19}$/;
const MEMBER_LOGIN_ID_HANGUL_RE = /^[가-힣]{4,12}$/;

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

export function normalizeMemberLoginId(raw: string): string {
  const trimmed = raw.trim();
  if (MEMBER_LOGIN_ID_HANGUL_RE.test(trimmed)) {
    return trimmed;
  }
  return trimmed.toLowerCase();
}

export function getMemberLoginIdFormatError(loginId: string): string | null {
  const trimmed = loginId.trim();
  if (!trimmed) {
    return "로그인 ID를 입력해 주세요.";
  }
  const id = normalizeMemberLoginId(loginId);
  const asciiOk = MEMBER_LOGIN_ID_ASCII_RE.test(id);
  const hangulOk = MEMBER_LOGIN_ID_HANGUL_RE.test(id);
  if (!asciiOk && !hangulOk) {
    return "한글 4~12자(띄어쓰기 없음) 또는 영문 소문자로 시작하는 4~20자(영문·숫자·밑줄)만 사용할 수 있습니다.";
  }
  if (!hangulOk && RESERVED.has(id)) {
    return "사용할 수 없는 로그인 ID입니다.";
  }
  if (ATTN_LIKE_RE.test(id)) {
    return "시스템 발급 번호 형식은 사용할 수 없습니다.";
  }
  return null;
}
