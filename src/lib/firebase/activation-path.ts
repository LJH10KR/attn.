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
  if (state.primaryStatus === "invitation_sent") {
    const p = new URLSearchParams();
    if (state.primaryAcademyId) p.set("academyId", state.primaryAcademyId);
    const qs = p.toString();
    return `/${role}/complete${qs ? `?${qs}` : ""}`;
  }
  if (state.primaryStatus === "pending_email_verification") {
    return `/login/${role}`;
  }
  const q = new URLSearchParams();
  q.set("state", state.primaryStatus);
  if (state.primaryAcademyId) q.set("academyId", state.primaryAcademyId);
  return `/${role}/session?${q.toString()}`;
}
