"use client";

import { useDashboardRefetchOnFocus } from "@/lib/firebase/use-dashboard-refetch-on-focus";

/**
 * 학원 관리 목록 — 유휴 시 주기 폴링 없음. 마운트·탭 복귀·`refresh()`·패널 「새로고침」.
 * Callable·쓰기 직후에는 `refresh()`로 즉시 갱신하세요.
 */
export function useAcademyListPoll(
  load: () => Promise<void>,
  deps: readonly unknown[],
): { refresh: () => void; busy: boolean } {
  return useDashboardRefetchOnFocus(load, deps, { pollMs: 0 });
}
