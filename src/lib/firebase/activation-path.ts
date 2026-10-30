export type RoleActivationState = {
  anyActive: boolean;
  primaryStatus: string | null;
  primaryAcademyId: string | null;
};

/**
 * 활성 상태 → 기본 진입 경로(활성이면 역할 대시보드, 그 밖은 설정·안내 화면).
 * 활성 직원의 학원 화면 착지는 `staff-landing.ts`가 이어서 판단한다.
 */
export function activationPathFromState(
  role: "teacher" | "parent",
  state: RoleActivationState,
): string | null {
  if (state.anyActive) {
    return `/${role}`;
  }
  if (!state.primaryStatus) {
    return null;
  }
  if (state.primaryStatus === "pending_setup") {
    return `/${role}/setup`;
  }
  // 학부모 승인 대기·연결 대기 — 학부모 홈이 연결 대기 화면을 보여 준다(Auth는 켜져 있음)
  if (role === "parent" && state.primaryStatus === "pending_approval") {
    return "/parent";
  }
  if (state.primaryStatus === "pending_email_verification") {
    return `/login/${role}`;
  }
  const q = new URLSearchParams();
  q.set("state", state.primaryStatus);
  if (state.primaryAcademyId) q.set("academyId", state.primaryAcademyId);
  return `/${role}/session?${q.toString()}`;
}
