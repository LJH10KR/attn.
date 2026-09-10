"use client";

import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardNotificationRow } from "@/components/dashboard/dashboard-notifications-modal";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";

export type AttendanceLogItem = {
  id: string;
  academyId: string;
  kind: "present" | "absent";
  studentId: string;
  studentName: string;
  parentUserId: string;
  senderRole: string;
  senderUid: string;
  senderDisplayName: string;
  parentDisplayName: string;
  source: string;
  createdAtMillis: number | null;
};

function formatWhen(ms: number | null): string {
  if (!ms) return "시간 정보 없음";
  return new Date(ms).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dismissedStorageKey(scopeKey: string): string {
  return `attn_attendance_log_dismissed_v1_${scopeKey}`;
}

function loadDismissed(scopeKey: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(dismissedStorageKey(scopeKey));
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function saveDismissed(scopeKey: string, set: Set<string>): void {
  try {
    const arr = [...set].slice(0, 500);
    localStorage.setItem(dismissedStorageKey(scopeKey), JSON.stringify(arr));
  } catch {
    // ignore quota/private mode
  }
}

export function useAttendanceNotificationLog(params: {
  academyId: string | null;
  limit?: number;
  includeAdminAll?: boolean;
  pollMs?: number;
  storageScopeKey: string;
}) {
  const {
    academyId,
    limit = 50,
    includeAdminAll = false,
    pollMs = 20_000,
    storageScopeKey,
  } = params;
  const [items, setItems] = useState<AttendanceLogItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setDismissed(loadDismissed(storageScopeKey));
  }, [storageScopeKey]);

  const refresh = useCallback(async () => {
    if (!academyId && !includeAdminAll) {
      setItems([]);
      return;
    }
    setBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "listAttendanceNotifications");
      const res = await fn({
        ...(academyId ? { academyId } : {}),
        limit,
      });
      const data = res.data as { items?: unknown };
      const next = Array.isArray(data.items)
        ? (data.items as AttendanceLogItem[])
        : [];
      if (!mountedRef.current) return;
      setItems(next);
      setError(null);
      setDismissed((prev) => {
        const idSet = new Set(next.map((x) => x.id));
        const filtered = new Set([...prev].filter((id) => idSet.has(id)));
        if (filtered.size !== prev.size) {
          saveDismissed(storageScopeKey, filtered);
          return filtered;
        }
        return prev;
      });
    } catch (e) {
      if (!mountedRef.current) return;
      setItems([]);
      setError(e instanceof Error ? e.message : "알림 기록을 불러오지 못했습니다.");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [academyId, includeAdminAll, limit, storageScopeKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!pollMs || pollMs < 5_000) return;
    const id = window.setInterval(() => {
      void refresh();
    }, pollMs);
    return () => window.clearInterval(id);
  }, [pollMs, refresh]);

  const visibleItems = useMemo(
    () => items.filter((x) => !dismissed.has(x.id)),
    [items, dismissed],
  );

  const modalItems = useMemo<DashboardNotificationRow[]>(
    () =>
      visibleItems.map((x) => ({
        id: x.id,
        title: `${x.kind === "present" ? "출석" : "결석"} · ${x.studentName || x.studentId}`,
        detail: `${formatWhen(x.createdAtMillis)} · ${x.senderDisplayName} · ${x.parentDisplayName} 학부모`,
      })),
    [visibleItems],
  );

  const dismissOne = useCallback(
    (id: string) => {
      setDismissed((prev) => {
        const next = new Set(prev);
        next.add(id);
        saveDismissed(storageScopeKey, next);
        return next;
      });
    },
    [storageScopeKey],
  );

  const dismissAll = useCallback(() => {
    setDismissed((prev) => {
      const next = new Set(prev);
      items.forEach((x) => next.add(x.id));
      saveDismissed(storageScopeKey, next);
      return next;
    });
  }, [items, storageScopeKey]);

  return {
    items,
    visibleItems,
    modalItems,
    count: visibleItems.length,
    error,
    busy,
    refresh,
    dismissOne,
    dismissAll,
  };
}
