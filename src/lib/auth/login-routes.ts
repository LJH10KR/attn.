/** 학원 포털 공용 로그인("academy")은 폐지 — 원장·직원·학부모 모두 각자 계정 */
export type LoginRole = "owner" | "teacher" | "parent";

export const LOGIN_ROLE_OPTIONS: {
  id: LoginRole;
  label: string;
  hint: string;
}[] = [
  { id: "owner", label: "오너", hint: "학원 등록·운영" },
  {
    id: "teacher",
    label: "선생님·직원",
    hint: "학원에서 초대받은 직원 계정",
  },
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
  return value === "owner" || value === "teacher" || value === "parent";
}

/** `/login/owner` 등 역할 고정 로그인 경로 */
export function isRoleLoginPath(pathname: string): boolean {
  return /^\/login\/(owner|teacher|parent)\/?$/.test(pathname);
}
