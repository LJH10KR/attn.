"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useState } from "react";
import { AbsenceRecordModal } from "@/components/academy/absence-record-modal";
import { formatRecordDate, seoulDateString } from "@/lib/academy/attendance-records";
import {
  loadStudentAttendance,
  type StudentAttendanceRow,
} from "@/lib/academy/student-detail/attendance-source";
import { ABSENCE_REASON_LABELS } from "@/lib/firebase/attn-schema";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";

function roleLabel(role: string): string {
  if (role === "teacher") return "선생님";
  if (role === "owner") return "원장";
  if (role === "academy") return "학원";
  if (role === "student_kiosk") return "키오스크";
  return "";
}

function currentYearMonth(): { year: number; month: number } {
  const [y, m] = seoulDateString().split("-").map(Number);
  return { year: y!, month: m! };
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

const smallBtn =
  "rounded-[8px] border border-neutral-300/70 bg-white/70 px-2.5 py-1 text-[11px] font-medium text-neutral-700 hover:bg-white/90 disabled:opacity-40";

/**
 * 출결 탭 — 월별 출결 기록(예전 출결 기록 모달을 옮김). 읽기 `lessons.attendance`·`billing.invoices`,
 * 결석 기록·사유 정정·삭제는 `lessons.attendance`(`canRecord`).
 */
export function StudentAttendanceTab({
  academyId,
  studentId,
  studentName,
  canRecord,
  onNoticeAction,
}: {
  academyId: string;
  studentId: string;
  studentName: string;
  canRecord: boolean;
  onNoticeAction: (message: string) => void;
}) {
  const [{ year, month }, setYm] = useState(currentYearMonth);
  const [rows, setRows] = useState<StudentAttendanceRow[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDate, setConfirmDate] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [editTarget, setEditTarget] = useState<StudentAttendanceRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const fetchRows = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const key = monthKey(year, month);
      setRows(await loadStudentAttendance(academyId, studentId, { from: `${key}-01`, to: `${key}-31` }));
    } catch (e) {
      setRows([]);
      setError(e instanceof Error ? e.message : "출결 기록을 불러오지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, [academyId, studentId, year, month]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const now = currentYearMonth();
  const isMaxMonth = year * 12 + month >= now.year * 12 + now.month + 1;

  const goMonth = (delta: -1 | 1) => {
    let y = year;
    let m = month + delta;
    if (m < 1) {
      y -= 1;
      m = 12;
    } else if (m > 12) {
      y += 1;
      m = 1;
    }
    // 미리 입력한 결석(휴원 등)을 볼 수 있도록 다음 달까지 이동 허용
    if (y * 12 + m > now.year * 12 + now.month + 1) return;
    setConfirmDate(null);
    setYm({ year: y, month: m });
  };

  const deleteRecord = async (date: string) => {
    setDeleteBusy(true);
    try {
      await httpsCallable(getFirebaseFunctions(), "deleteStudentAttendanceRecord")({ academyId, studentId, date });
      setRows((prev) => prev.filter((r) => r.date !== date));
      setConfirmDate(null);
      onNoticeAction(`${studentName} ${formatRecordDate(date)} 출결 기록을 삭제했습니다.`);
    } catch (e) {
      setError(e instanceof FirebaseError && e.message ? e.message : "삭제에 실패했습니다.");
    } finally {
      setDeleteBusy(false);
    }
  };

  const absences = rows.filter((r) => r.status === "absent");
  const deductibleCount = absences.filter((r) => r.reason === "illness" || r.reason === "academy").length;
  const billedCount = absences.filter((r) => r.billedInvoicePeriod).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => goMonth(-1)} disabled={busy} className={smallBtn} aria-label="이전 달">
            ‹
          </button>
          <span className="min-w-[84px] text-center text-sm font-semibold text-foreground">
            {year}년 {month}월
          </span>
          <button
            type="button"
            onClick={() => goMonth(1)}
            disabled={busy || isMaxMonth}
            className={smallBtn}
            aria-label="다음 달"
          >
            ›
          </button>
        </div>
        {canRecord ? (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="rounded-[8px] border border-amber-400/70 bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-950"
          >
            결석 기록
          </button>
        ) : null}
      </div>
      <p className="text-[11px] text-neutral-500">
        {busy
          ? "불러오는 중…"
          : `결석 ${absences.length}일 (차감 대상 ${deductibleCount}일, 청구 반영 ${billedCount}일)`}
      </p>

      {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p> : null}

      {busy ? null : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-neutral-400">이 달의 출결 기록이 없습니다.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => {
            const deductible = r.reason === "illness" || r.reason === "academy";
            const confirming = confirmDate === r.date;
            return (
              <li
                key={r.date}
                className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 ${
                  deductible ? "bg-amber-50/80 ring-1 ring-amber-200/70" : "bg-white/50"
                }`}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium text-foreground">{formatRecordDate(r.date)}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        r.status === "present"
                          ? "bg-emerald-500/15 text-emerald-900"
                          : "bg-neutral-500/15 text-neutral-800"
                      }`}
                    >
                      {r.status === "present" ? "출석" : "결석"}
                    </span>
                    {r.reason ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          deductible ? "bg-amber-500/25 text-amber-950" : "bg-neutral-500/10 text-neutral-600"
                        }`}
                      >
                        {ABSENCE_REASON_LABELS[r.reason]}
                      </span>
                    ) : null}
                    {r.billedInvoicePeriod ? (
                      <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-900">
                        {Number(r.billedInvoicePeriod.slice(5))}월 청구 반영
                      </span>
                    ) : null}
                    <span className="text-[10px] text-neutral-500">{roleLabel(r.recordedByRole)}</span>
                  </div>
                  {r.note ? <p className="mt-0.5 truncate text-[11px] text-neutral-600">{r.note}</p> : null}
                </div>
                {canRecord ? (
                  <div className="flex shrink-0 gap-1.5">
                    {r.billedInvoicePeriod ? (
                      <span className="text-[10px] text-neutral-500">수정 잠금</span>
                    ) : confirming ? (
                      <>
                        <button
                          type="button"
                          disabled={deleteBusy}
                          className={smallBtn}
                          onClick={() => setConfirmDate(null)}
                        >
                          아니요
                        </button>
                        <button
                          type="button"
                          disabled={deleteBusy}
                          className="rounded-[8px] bg-red-500 px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
                          onClick={() => void deleteRecord(r.date)}
                        >
                          {deleteBusy ? "삭제 중…" : "삭제"}
                        </button>
                      </>
                    ) : (
                      <>
                        {r.status === "absent" ? (
                          <button
                            type="button"
                            disabled={deleteBusy}
                            className={smallBtn}
                            onClick={() => setEditTarget(r)}
                          >
                            사유
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={deleteBusy}
                          className="rounded-[8px] border border-red-200/80 bg-white/70 px-2.5 py-1 text-[11px] font-medium text-red-600 disabled:opacity-40"
                          onClick={() => setConfirmDate(r.date)}
                        >
                          삭제
                        </button>
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {editTarget ? (
        <AbsenceRecordModal
          academyId={academyId}
          studentId={studentId}
          studentName={studentName}
          initialDate={editTarget.date}
          initialReason={editTarget.reason ?? "general"}
          initialNote={editTarget.note}
          onClose={() => setEditTarget(null)}
          onSaved={(message) => {
            setEditTarget(null);
            onNoticeAction(message);
            void fetchRows();
          }}
        />
      ) : null}
      {addOpen ? (
        <AbsenceRecordModal
          academyId={academyId}
          studentId={studentId}
          studentName={studentName}
          onClose={() => setAddOpen(false)}
          onSaved={(message) => {
            setAddOpen(false);
            onNoticeAction(message);
            void fetchRows();
          }}
        />
      ) : null}
    </div>
  );
}
