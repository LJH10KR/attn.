export const PASSWORD_MATCH_MSG = "비밀번호가 일치합니다.";
export const PASSWORD_MISMATCH_MSG = "비밀번호가 일치하지 않습니다.";

export type PasswordConfirmHint = "none" | "match" | "mismatch";

export function resolvePasswordConfirmHint(
  password: string,
  confirm: string,
  confirmBlurred: boolean,
): PasswordConfirmHint {
  if (password.length > 0 && confirm === password) {
    return "match";
  }
  if (confirm.length === password.length && confirm !== password && password.length > 0) {
    return "mismatch";
  }
  if (confirmBlurred && confirm !== password && (password.length > 0 || confirm.length > 0)) {
    return "mismatch";
  }
  return "none";
}
