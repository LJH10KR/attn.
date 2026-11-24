"use client";

import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useState } from "react";
import { ModalPortal } from "@/components/ui/modal-portal";
import { classRecordLabel, reasonLabel } from "@/lib/academy/attendance-labels";
import { attendanceActionErrorMessage, formatRecordDate } from "@/lib/academy/attendance-records";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

/** `getStudentAttendanceHistory` 응답(★13) — 메모·코멘트·휴강 메모·처리자는 서버가 내려주지 않는다 */
type HistoryDay = {
  date: string;
  arrival: {
    status: "present" | "absent";
    arrivedAt: string | null;
    departed: boolean;
    leftAt: string | null;
    reason: string | null;
  } | null;
  classes: {
    classId: string;
    className: string;
    status: "present" | "late" | "absent";
    lateMinutes: number | null;
    reason: string | null;
  }[];
  cancellations: { classId: string; className: string }[];
  corrected: boolean;
};

const CLASS_TONE = {
  present: "bg-emerald-500/15 text-emerald-900",
  late: "bg-violet-500/15 text-violet-900",
  absent: "bg-amber-500/20 text-amber-950",
} as const;

function arrivalText(a: NonNullable<HistoryDay["arrival"]>): string {
  if (a.status === "absent") {
    const r = reasonLabel(a.reason);
    return r && a.reason !== "general" ? `미등원(${r})` : "미등원";
  }
  return a.arrivedAt ? `등원 ${a.arrivedAt}` : "등원";
}

/**
 * 3-B 학부모 앱 자녀 출결 기록(B8·★13) — 오늘 포함 31일, 기록 있는 날만(휴강만 있는 날 포함, P2).
 * 연결된 활성 학부모만(서버). 읽기 전용.
 */
export function ParentAttendanceHistorySheet({
  academyId,
  studentId,
  studentName,
  onCloseAction,
}: {
  academyId: string;
  studentId: string;
  studentName: string;
  onCloseAction: () => void;
}) {
  useBodyScrollLock(true);
  const [days, setDays] = useState<HistoryDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setDays(null);
    try {
      const res = await httpsCallable(getFirebaseFunctions(), "getStudentAttendanceHistory")({ academyId, studentId });
      const data = res.data as { days?: HistoryDay[] };
      setDays(Array.isArray(data.days) ? data.days : []);
    } catch (e) {
      setError(attendanceActionErrorMessage(e, "출결 기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."));
    }
  }, [academyId, studentId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCloseAction]);

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[200] flex items-end justify-center bg-black/40 sm:items-center"
        role="presentation"
        onClick={onCloseAction}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="parent-attendance-history-title"
          className="flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-3xl bg-[#f7f6f2] shadow-2xl dark:bg-neutral-900 sm:rounded-3xl"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="flex shrink-0 items-start justify-between gap-2 px-5 pb-2 pt-4">
            <div className="min-w-0">
              <h2 id="parent-attendance-history-title" className="truncate text-base font-semibold text-foreground">
                {studentName} 출결 기록
              </h2>
              <p className="text-xs text-neutral-500">최근 31일 · 기록이 있는 날만</p>
            </div>
            <button
              type="button"
              onClick={onCloseAction}
              className="rounded-full px-2 py-1 text-sm text-neutral-500"
              aria-label="닫기"
            >
              ✕
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-[calc(max(1.25rem,env(safe-area-inset-bottom))+12px)]">
            {error ? (
              <div className="py-8 text-center">
                <p className="break-keep text-sm text-red-700">{error}</p>
                <button
                  type="button"
                  onClick={() => void load()}
                  className="mt-3 rounded-full border border-neutral-300 px-4 py-1.5 text-xs font-medium"
                >
                  다시 시도
                </button>
              </div>
            ) : days === null ? (
              <p className="py-10 text-center text-sm text-neutral-400">불러오는 중…</p>
            ) : days.length === 0 ? (
              <p className="py-10 text-center text-sm text-neutral-500">최근 31일 출결 기록이 없습니다.</p>
            ) : (
              <ul className="space-y-1.5">
                {days.map((d) => (
                  <li key={d.date} className="rounded-xl bg-white/70 px-3 py-2.5 dark:bg-white/5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium text-foreground">{formatRecordDate(d.date)}</span>
                      {d.arrival ? (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            d.arrival.status === "present"
                              ? "bg-emerald-500/15 text-emerald-900"
                              : "bg-neutral-500/15 text-neutral-800"
                          }`}
                        >
                          {arrivalText(d.arrival)}
                        </span>
                      ) : null}
                      {d.arrival?.status === "present" && d.arrival.departed ? (
                        <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-900">
                          하원{d.arrival.leftAt ? ` ${d.arrival.leftAt}` : ""}
                        </span>
                      ) : null}
                      {d.corrected ? <span className="text-[10px] text-sky-800">정정됨</span> : null}
                    </div>
                    {d.classes.length > 0 || d.cancellations.length > 0 ? (
                      <ul className="mt-1.5 space-y-1 border-t border-neutral-200/60 pt-1.5">
                        {d.classes.map((c) => (
                          <li key={c.classId} className="flex items-center gap-1.5 text-[11px]">
                            <span className="min-w-0 truncate text-neutral-700 dark:text-neutral-300">{c.className}</span>
                            <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${CLASS_TONE[c.status]}`}>
                              {classRecordLabel(c)}
                            </span>
                          </li>
                        ))}
                        {d.cancellations.map((c) => (
                          <li key={`cancel-${c.classId}`} className="flex items-center gap-1.5 text-[11px]">
                            <span className="min-w-0 truncate text-neutral-700 dark:text-neutral-300">{c.className}</span>
                            <span className="ml-auto shrink-0 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold text-rose-900">
                              휴강
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
