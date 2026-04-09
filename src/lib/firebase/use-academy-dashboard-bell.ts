"use client";

import {
  collection,
  onSnapshot,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardNotificationRow } from "@/components/dashboard/dashboard-notifications-modal";
import {
  COLLECTIONS,
  PARENT_INVITE_TTL_MS,
  TEACHER_INVITE_TTL_MS,
  type ParentRegistrationStatus,
  type TeacherRegistrationStatus,
} from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";

function readTs(v: unknown): Timestamp | undefined {
  return v instanceof Timestamp ? v : undefined;
}

function inviteExpired(
  status: TeacherRegistrationStatus | ParentRegistrationStatus,
  invitedAt: Timestamp | undefined,
  invitationExpiresAt: Timestamp | undefined,
  ttlMs: number,
  now: number,
): boolean {
  if (status !== "invitation_sent") return false;
  let exp = invitationExpiresAt;
  if (!exp && invitedAt) {
    exp = Timestamp.fromMillis(invitedAt.toMillis() + ttlMs);
  }
  if (!exp) return false;
  return exp.toMillis() <= now;
}

function mapTeacherDoc(
  id: string,
  data: Record<string, unknown>,
  now: number,
): DashboardNotificationRow[] {
  const status = (data.status as TeacherRegistrationStatus) || "invitation_needed";
  const name =
    typeof data.displayName === "string" && data.displayName.trim()
      ? data.displayName.trim()
      : "이름 미입력";
  const email = typeof data.email === "string" ? data.email : "";
  const invitedAt = readTs(data.invitedAt);
  const invitationExpiresAt = readTs(data.invitationExpiresAt);
  const rows: DashboardNotificationRow[] = [];

  if (status === "pending_registration") {
    rows.push({
      id: `t-pending-${id}`,
      title: `선생님 최종 등록 대기: ${name}`,
      detail: email ? email : undefined,
    });
  }
  if (inviteExpired(status, invitedAt, invitationExpiresAt, TEACHER_INVITE_TTL_MS, now)) {
    rows.push({
      id: `t-expired-${id}`,
      title: `선생님 초청 만료: ${name}`,
      detail: email ? `${email} · 초청 재발송이 필요합니다` : "초청 재발송이 필요합니다",
    });
  }
  return rows;
}

function mapParentDoc(
  id: string,
  data: Record<string, unknown>,
  now: number,
): DashboardNotificationRow[] {
  const status = (data.status as ParentRegistrationStatus) || "invitation_needed";
  const name =
    typeof data.displayName === "string" && data.displayName.trim()
      ? data.displayName.trim()
      : "이름 미입력";
  const email = typeof data.email === "string" ? data.email : "";
  const invitedAt = readTs(data.invitedAt);
  const invitationExpiresAt = readTs(data.invitationExpiresAt);
  const rows: DashboardNotificationRow[] = [];

  if (status === "pending_registration") {
    rows.push({
      id: `p-pending-${id}`,
      title: `학부모 최종 등록 대기: ${name}`,
      detail: email ? email : undefined,
    });
  }
  if (inviteExpired(status, invitedAt, invitationExpiresAt, PARENT_INVITE_TTL_MS, now)) {
    rows.push({
      id: `p-expired-${id}`,
      title: `학부모 초청 만료: ${name}`,
      detail: email ? `${email} · 초청 재발송이 필요합니다` : "초청 재발송이 필요합니다",
    });
  }
  return rows;
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

/**
 * 학원 대시보드 알림벨 — 초청 만료·최종 등록 대기(선생님/학부모).
 * 삭제는 Firestore 문서가 아니라 로컬 가림(dismiss)입니다.
 */
export function useAcademyDashboardBell(academyId: string | null) {
  const [teacherDocs, setTeacherDocs] = useState<
    { id: string; data: Record<string, unknown> }[]
  >([]);
  const [parentDocs, setParentDocs] = useState<
    { id: string; data: Record<string, unknown> }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  const rawItemsRef = useRef<DashboardNotificationRow[]>([]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!academyId) {
      setDismissed(new Set());
      return;
    }
    setDismissed(loadDismissed(academyId));
  }, [academyId]);

  useEffect(() => {
    if (!academyId) {
      setTeacherDocs([]);
      setParentDocs([]);
      setError(null);
      return;
    }
    const db = getFirebaseDb();
    const statuses = ["pending_registration", "invitation_sent"] as const;
    const tq = query(
      collection(db, COLLECTIONS.academies, academyId, "teachers"),
      where("status", "in", [...statuses]),
    );
    const pq = query(
      collection(db, COLLECTIONS.academies, academyId, "parents"),
      where("status", "in", [...statuses]),
    );

    const unsubT = onSnapshot(
      tq,
      (snap) => {
        setError(null);
        setTeacherDocs(snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })));
      },
      (err) => {
        setError(err.message || "알림을 불러오지 못했습니다.");
        setTeacherDocs([]);
      },
    );
    const unsubP = onSnapshot(
      pq,
      (snap) => {
        setError(null);
        setParentDocs(snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })));
      },
      (err) => {
        setError(err.message || "알림을 불러오지 못했습니다.");
        setParentDocs([]);
      },
    );
    return () => {
      unsubT();
      unsubP();
    };
  }, [academyId]);

  const rawItems = useMemo(() => {
    const now = nowMs;
    const out: DashboardNotificationRow[] = [];
    for (const d of teacherDocs) {
      out.push(...mapTeacherDoc(d.id, d.data, now));
    }
    for (const d of parentDocs) {
      out.push(...mapParentDoc(d.id, d.data, now));
    }
    out.sort((a, b) => a.title.localeCompare(b.title, "ko"));
    return out;
  }, [teacherDocs, parentDocs, nowMs]);

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

  return { items, error, count: items.length, dismissOne, dismissAllVisible };
}
