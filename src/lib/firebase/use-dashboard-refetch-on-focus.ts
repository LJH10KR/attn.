"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type DashboardRefetchOnFocusOptions = {
  /**
   * 주기 폴링(ms). 생략·0이면 유휴 타이머 없음(마운트·탭 복귀·`refresh()`만).
   */
  pollMs?: number;
  /** false면 effect 마운트 시 자동 load 생략 */
  loadOnMount?: boolean;
};

/**
 * 대시보드 데이터 — 실시간 Listen 대신 마운트·탭 복귀·선택적 주기·수동 `refresh()`.
 */
export function useDashboardRefetchOnFocus(
  load: () => void | Promise<void>,
  deps: readonly unknown[],
  options?: DashboardRefetchOnFocusOptions,
): { refresh: () => void; busy: boolean } {
  const loadRef = useRef(load);
  loadRef.current = load;

  const [busy, setBusy] = useState(false);
  const pollMs = options?.pollMs ?? 0;
  const loadOnMount = options?.loadOnMount ?? true;

  const refresh = useCallback(() => {
    void (async () => {
      setBusy(true);
      try {
        await loadRef.current();
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const run = () => {
      if (cancelled) return;
      void (async () => {
        setBusy(true);
        try {
          await loadRef.current();
        } finally {
          if (!cancelled) setBusy(false);
        }
      })();
    };

    if (loadOnMount) run();

    let intervalId: number | undefined;
    if (pollMs > 0) {
      intervalId = window.setInterval(run, pollMs);
    }

    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (intervalId !== undefined) window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller deps (e.g. academyId)
  }, [...deps, pollMs, loadOnMount]);

  return { refresh, busy };
}
