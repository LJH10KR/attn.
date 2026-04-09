"use client";

import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
} from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import type { DashboardNotificationRow } from "@/components/dashboard/dashboard-notifications-modal";
import { getFirebaseDb } from "@/lib/firebase/client-app";

/** Cloud Functions `sendStudentAttendanceNotification`가 기록 — 클라이언트는 읽기만 */
export const PARENT_USER_DASHBOARD_BELL_COLLECTION = "dashboardBellItems";

function formatWhen(ts: Timestamp | undefined): string | undefined {
  if (!ts) return undefined;
  try {
    return ts.toDate().toLocaleString("ko-KR", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return undefined;
  }
}

/**
 * 학부모 대시보드 알림벨 — 자녀 출석/결석 알림(인앱 목록).
 */
export function useParentDashboardBell(parentUid: string | null) {
  const [rows, setRows] = useState<
    { id: string; body: string; createdAt?: Timestamp }[]
  >([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!parentUid) {
      setRows([]);
      setError(null);
      return;
    }
    const db = getFirebaseDb();
    const qy = query(
      collection(db, "users", parentUid, PARENT_USER_DASHBOARD_BELL_COLLECTION),
      orderBy("createdAt", "desc"),
      limit(50),
    );
    const unsub = onSnapshot(
      qy,
      (snap) => {
        setError(null);
        setRows(
          snap.docs.map((d) => {
            const data = d.data() as Record<string, unknown>;
            const body = typeof data.body === "string" ? data.body : "알림";
            const createdAt = data.createdAt instanceof Timestamp ? data.createdAt : undefined;
            return { id: d.id, body, createdAt };
          }),
        );
      },
      (err) => {
        setError(err.message || "알림을 불러오지 못했습니다.");
        setRows([]);
      },
    );
    return () => unsub();
  }, [parentUid]);

  const items = useMemo((): DashboardNotificationRow[] => {
    return rows.map((r) => ({
      id: r.id,
      title: r.body,
      detail: formatWhen(r.createdAt),
    }));
  }, [rows]);

  return { items, error, count: items.length };
}
