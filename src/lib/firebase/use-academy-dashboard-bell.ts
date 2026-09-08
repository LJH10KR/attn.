"use client";

import { collection, getDocs, limit, orderBy, query, Timestamp } from "firebase/firestore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardNotificationRow } from "@/components/dashboard/dashboard-notifications-modal";
import {
  ACADEMY_ADMIN_INBOX_SCHEMA_VERSION,
  academyAdminInboxCollectionPath,
  PARENT_INVITE_TTL_MS,
  TEACHER_INVITE_TTL_MS,
  type AcademyAdminInboxDoc,
} from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";
import { useDashboardRefetchOnFocus } from "@/lib/firebase/use-dashboard-refetch-on-focus";
import { setAppIconBadgeCount } from "@/lib/ios/app-badge";

function readTs(v: unknown): Timestamp | undefined {
  return v instanceof Timestamp ? v : undefined;
}

function inviteExpired(
  invitedAt: Timestamp | undefined,
  invitationExpiresAt: Timestamp | undefined,
  ttlMs: number,
  now: number,
): boolean {
  let exp = invitationExpiresAt;
  if (!exp && invitedAt) {
    exp = Timestamp.fromMillis(invitedAt.toMillis() + ttlMs);
  }
  if (!exp) return false;
  return exp.toMillis() <= now;
}

function mapInboxDoc(id: string, data: Record<string, unknown>, now: number): DashboardNotificationRow[] {
  if (data.schemaVersion !== ACADEMY_ADMIN_INBOX_SCHEMA_VERSION) return [];

  const kind = data.kind as AcademyAdminInboxDoc["kind"];
  const entityType = data.entityType as AcademyAdminInboxDoc["entityType"];
  const name =
    typeof data.displayName === "string" && data.displayName.trim()
      ? data.displayName.trim()
      : "이름 미입력";
  const email = typeof data.email === "string" ? data.email : "";
  const invitedAt = readTs(data.invitedAt);
  const invitationExpiresAt = readTs(data.invitationExpiresAt);
  const ttlMs = entityType === "teacher" ? TEACHER_INVITE_TTL_MS : PARENT_INVITE_TTL_MS;
  const roleLabel = entityType === "teacher" ? "선생님" : "학부모";

  if (kind === "pending_registration") {
    return [
      {
        id,
        title: `${roleLabel} 최종 등록 대기: ${name}`,
        detail: email || undefined,
      },
    ];
  }

  if (kind === "invitation_sent") {
    if (inviteExpired(invitedAt, invitationExpiresAt, ttlMs, now)) {
      return [
        {
          id,
          title: `${roleLabel} 초청 만료: ${name}`,
          detail: email ? `${email} · 초청 재발송이 필요합니다` : "초청 재발송이 필요합니다",
        },
      ];
    }
  }

  return [];
}

function dismissedStorageKey(academyId: string): string {
  return `attn_academy_bell_dismissed_v1_${academyId}`;
}

function loadDismissed(academyId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(dismissedStorageKey(academyId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function saveDismissed(academyId: string, set: Set<string>): void {
  try {
    const arr = [...set].slice(0, 400);
    localStorage.setItem(dismissedStorageKey(academyId), JSON.stringify(arr));
  } catch {
    /* quota / private mode */
  }
}

/** 초청 만료 판정용 클라이언트 시계 — inbox `invitation_sent` 항목 표시용 */
const BELL_EXPIRY_TICK_MS = 60_000;

/**
 * 학원 대시보드 알림벨 — `adminInbox` (Functions 유지) 기반.
 * Firestore는 마운트·탭 복귀·`refresh()`(모달 열기 등) 시에만 조회합니다.
 */
export function useAcademyDashboardBell(academyId: string | null) {
  const [inboxDocs, setInboxDocs] = useState<{ id: string; data: Record<string, unknown> }[]>(
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  const rawItemsRef = useRef<DashboardNotificationRow[]>([]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), BELL_EXPIRY_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!academyId) {
      setDismissed(new Set());
      return;
    }
    setDismissed(loadDismissed(academyId));
  }, [academyId]);

  const loadBellInbox = useCallback(async () => {
    if (!academyId) {
      setInboxDocs([]);
      setError(null);
      return;
    }
    try {
      const db = getFirebaseDb();
      const snap = await getDocs(
        query(
          collection(db, academyAdminInboxCollectionPath(academyId)),
          orderBy("createdAt", "desc"),
          limit(50),
        ),
      );
      setError(null);
      setInboxDocs(
        snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "알림을 불러오지 못했습니다.";
      setError(msg);
      setInboxDocs([]);
    }
  }, [academyId]);

  const { refresh } = useDashboardRefetchOnFocus(loadBellInbox, [academyId], {
    pollMs: 0,
    loadOnMount: Boolean(academyId),
  });

  const rawItems = useMemo(() => {
    const now = nowMs;
    const out: DashboardNotificationRow[] = [];
    for (const d of inboxDocs) {
      out.push(...mapInboxDoc(d.id, d.data, now));
    }
    out.sort((a, b) => a.title.localeCompare(b.title, "ko"));
    return out;
  }, [inboxDocs, nowMs]);

  rawItemsRef.current = rawItems;

  const rawIdsKey = useMemo(
    () =>
      rawItems
        .map((i) => i.id)
        .sort()
        .join("\u0001"),
    [rawItems],
  );

  useEffect(() => {
    if (!academyId) return;
    const raw = rawItemsRef.current;
    const rawIds = new Set(raw.map((i) => i.id));
    if (rawIds.size === 0) return;
    setDismissed((prev) => {
      const next = new Set([...prev].filter((id) => rawIds.has(id)));
      if (next.size === prev.size && [...prev].every((id) => next.has(id))) return prev;
      saveDismissed(academyId, next);
      return next;
    });
  }, [academyId, rawIdsKey]);

  const items = useMemo(
    () => rawItems.filter((i) => !dismissed.has(i.id)),
    [rawItems, dismissed],
  );

  useEffect(() => {
    setAppIconBadgeCount(items.length, {
      badgeUserId: academyId ? `academy:${academyId}` : undefined,
    });
  }, [items.length, academyId]);

  const dismissOne = useCallback(
    (id: string) => {
      if (!academyId) return;
      setDismissed((prev) => {
        const next = new Set(prev);
        next.add(id);
        saveDismissed(academyId, next);
        return next;
      });
    },
    [academyId],
  );

  const dismissAllVisible = useCallback(() => {
    if (!academyId) return;
    setDismissed((prev) => {
      const next = new Set(prev);
      rawItemsRef.current.forEach((i) => next.add(i.id));
      saveDismissed(academyId, next);
      return next;
    });
  }, [academyId]);

  return {
    items,
    error,
    count: items.length,
    dismissOne,
    dismissAllVisible,
    refresh,
  };
}
