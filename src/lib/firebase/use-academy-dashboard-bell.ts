"use client";

import {
  collection,
  onSnapshot,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
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

/**
 * 학원 대시보드 알림벨 — 초청 만료·최종 등록 대기(선생님/학부모).
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

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

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

  const items = useMemo(() => {
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

  return { items, error, count: items.length };
}
