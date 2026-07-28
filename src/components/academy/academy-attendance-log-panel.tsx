"use client";

import { useMemo } from "react";
import { useAttendanceNotificationLog } from "@/lib/firebase/use-attendance-notification-log";

const glassCard = "glass-card";

function roleLabel(role: string): string {
  if (role === "teacher") return "선생님";
  if (role === "owner") return "오너";
  if (role === "academy") return "학원";
  if (role === "admin") return "관리자";
  if (role === "student_kiosk") return "키오스크";
  return role || "알 수 없음";
}

function kindLabel(kind: "present" | "absent"): string {
  return kind === "present" ? "출석" : "결석";
}

function fmt(ms: number | null): string {
  if (!ms) return "시간 정보 없음";
  return new Date(ms).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AcademyAttendanceLogPanel({
  academyId,
  includeAdminAll = false,
  title = "알림 전송 기록",
  storageScopeKey,
}: {
  academyId: string | null;
  includeAdminAll?: boolean;
  title?: string;
  storageScopeKey: string;
}) {
  const { items, error, busy, refresh } = useAttendanceNotificationLog({
    academyId,
    includeAdminAll,
    limit: 100,
    pollMs: 20_000,
    storageScopeKey,
  });

  const rows = useMemo(() => items.slice(0, 100), [items]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="rounded-[8px] border border-neutral-300/80 bg-white/70 px-3 py-2 text-[11px] font-medium text-neutral-800 hover:bg-white disabled:opacity-50"
        >
          새로고침
        </button>
      </div>
      {error ? (
        <p className="rounded-2xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
          {error}
        </p>
      ) : null}

      {busy && rows.length === 0 ? (
        <p className={`py-10 text-center text-sm text-neutral-500 ${glassCard}`}>
          불러오는 중…
        </p>
      ) : rows.length === 0 ? (
        <p className={`py-10 text-center text-sm text-neutral-500 ${glassCard}`}>
          표시할 기록이 없습니다.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className={`p-3 ${glassCard}`}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    r.kind === "present"
                      ? "bg-emerald-500/15 text-emerald-900"
                      : "bg-amber-500/20 text-amber-900"
                  }`}
                >
                  {kindLabel(r.kind)}
                </span>
                <span className="text-xs font-medium text-foreground">
                  {r.studentName || r.studentId || "학생"}
                </span>
                <span className="text-[11px] text-neutral-500">{fmt(r.createdAtMillis)}</span>
              </div>
              <p className="mt-1 text-[11px] text-neutral-600">
                발신 {r.senderDisplayName}
                <span className="text-neutral-400"> ({roleLabel(r.senderRole)})</span>
              </p>
              <p className="mt-0.5 text-[11px] text-neutral-500">
                학부모 {r.parentDisplayName}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
