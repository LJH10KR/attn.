export type DashboardRole = "owner" | "teacher" | "parent";

const STORAGE_KEY = "attn_last_dashboard_role";

const PATH_BY_ROLE: Record<DashboardRole, string> = {
  owner: "/owner",
  teacher: "/teacher",
  parent: "/parent",
};

/**
 * 대시보드가 실제로 열린 역할을 기록 — 다음 콜드 실행 시 프리페치 힌트로만 쓰임.
 * 민감정보 아님(단순 UX 힌트), 진입 가능 여부는 각 페이지가 항상 스스로 재확인함.
 */
export function setLastDashboardRoleHint(role: DashboardRole): void {
  try {
    localStorage.setItem(STORAGE_KEY, role);
  } catch {
    /* private mode 등 — 무시 */
  }
}

/** 회원 탈퇴 뒤(2-N) — 첫 화면이 지운 계정의 대시보드를 미리 불러오지 않게 */
export function clearLastDashboardRoleHint(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 무시 */
  }
}

export function getLastDashboardRoleHintPath(): string | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "owner" || v === "teacher" || v === "parent" ? PATH_BY_ROLE[v] : null;
  } catch {
    return null;
  }
}
