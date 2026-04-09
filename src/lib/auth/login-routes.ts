export type LoginRole = "owner" | "academy" | "teacher" | "parent";

export const LOGIN_ROLE_OPTIONS: {
  id: LoginRole;
  label: string;
  hint: string;
}[] = [
  { id: "owner", label: "오너", hint: "학원 등록·운영" },
  {
    id: "academy",
    label: "학원",
    hint: "학원 운영(선생님/학부모/학생 관리)",
  },
  { id: "teacher", label: "선생님", hint: "학생 출석/결석 알림 전송" },
  {
    id: "parent",
    label: "학부모",
    hint: "자녀 출석/결석 확인 및 알림 받기",
  },
];

export function loginPathForRole(role: LoginRole): string {
  return `/login/${role}`;
}

export function isKnownLoginRole(value: string): value is LoginRole {
  return (
    value === "owner" ||
    value === "academy" ||
    value === "teacher" ||
    value === "parent"
  );
}

/** `/login/owner` 등 역할 고정 로그인 경로 */
export function isRoleLoginPath(pathname: string): boolean {
  return /^\/login\/(owner|academy|teacher|parent)\/?$/.test(pathname);
}
