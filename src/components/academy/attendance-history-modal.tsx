import { FirebaseError } from "firebase/app";
import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AbsenceRecordModal } from "@/components/academy/absence-record-modal";
import {
  ABSENCE_REASON_LABELS,
  academyStudentAttendanceRecordsPath,
  isAbsenceReason,
  type AbsenceReason,
  type AttendanceRecordDoc,
} from "@/lib/firebase/attn-schema";
import { getFirebaseDb, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { formatRecordDate, seoulDateString } from "@/lib/academy/attendance-records";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

type RecordRow = {
  date: string;
  status: "present" | "absent";
  reason: AbsenceReason | null;
  note: string;
  recordedByRole: string;
};

function roleLabel(role: string): string {
  if (role === "teacher") return "선생님";
  if (role === "owner") return "원장";
  if (role === "academy") return "학원";
  if (role === "student_kiosk") return "키오스크";
  return "알 수 없음";
}

function currentYearMonth(): { year: number; month: number } {
  const [y, m] = seoulDateString().split("-").map(Number);
  return { year: y!, month: m! };
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** 원장·학원 포털 — 학생의 월별 출결 기록 조회·정정 */
export function AttendanceHistoryModal({
  academyId,
  studentId,
  studentName,
  onClose,
  onNotice,
}: {
  academyId: string;
  studentId: string;
  studentName: string;
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const [{ year, month }, setYm] = useState(currentYearMonth);
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDate, setConfirmDate] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [editTarget, setEditTarget] = useState<RecordRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const childOpen = editTarget !== null || addOpen;

  useBodyScrollLock(true);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !deleteBusy && !childOpen) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, deleteBusy, childOpen, onClose]);

  const fetchRows = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const key = monthKey(year, month);
      const snap = await getDocs(
        query(
          collection(getFirebaseDb(), academyStudentAttendanceRecordsPath(academyId, studentId)),
          where("date", ">=", `${key}-01`),
          where("date", "<=", `${key}-31`),
          orderBy("date", "desc"),
        ),
      );
      setRows(
        snap.docs.map((d) => {
          const x = d.data() as Partial<AttendanceRecordDoc>;
          return {
            date: typeof x.date === "string" ? x.date : d.id,
            status: x.status === "absent" ? "absent" : "present",
            reason: isAbsenceReason(x.reason) ? x.reason : null,
            note: typeof x.note === "string" ? x.note : "",
            recordedByRole: typeof x.recordedByRole === "string" ? x.recordedByRole : "",
          };
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "출결 기록을 불러오지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, [academyId, studentId, year, month]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

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
    const now = currentYearMonth();
    if (y * 12 + m > now.year * 12 + now.month + 1) return;
    setConfirmDate(null);
    setYm({ year: y, month: m });
  };

  const deleteRecord = async (date: string) => {
    setDeleteBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "deleteStudentAttendanceRecord");
      await fn({ academyId, studentId, date });
      setRows((prev) => prev.filter((r) => r.date !== date));
      setConfirmDate(null);
      onNotice(`${studentName} ${formatRecordDate(date)} 출결 기록을 삭제했습니다.`);
    } catch (e) {
      setError(e instanceof FirebaseError && e.message ? e.message : "삭제에 실패했습니다.");
    } finally {
      setDeleteBusy(false);
    }
  };

  const absences = rows.filter((r) => r.status === "absent");
  const deductibleCount = absences.filter(
    (r) => r.reason === "illness" || r.reason === "academy",
  ).length;
  const now = currentYearMonth();
  const isMaxMonth = year * 12 + month >= now.year * 12 + now.month + 1;

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={() => {
        if (!busy && !deleteBusy && !childOpen) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="glass-card flex w-full max-w-lg flex-col shadow-2xl"
        style={{ maxHeight: "min(90dvh, 680px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-neutral-200/60 px-5 py-4 dark:border-white/10">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">{studentName} · 출결 기록</h2>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              {busy
                ? "불러오는 중…"
                : `${year}년 ${month}월 · 결석 ${absences.length}일 (차감 대상 ${deductibleCount}일)`}
            </p>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="rounded-[8px] border border-amber-400/70 bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-950 hover:bg-amber-500/25 dark:text-amber-200"
            >
              결석 추가
            </button>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="rounded-[8px] border border-neutral-300/80 bg-white/70 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-white/90"
            >
              닫기
            </button>
          </div>
        </div>

        <div className="flex items-center justify-center gap-3 border-b border-neutral-200/60 px-5 py-3 dark:border-white/10">
          <button
            type="button"
            onClick={() => goMonth(-1)}
            disabled={busy}
            className="rounded-[8px] border border-neutral-300/70 bg-white/55 px-3 py-1.5 text-xs font-medium hover:bg-white/90 disabled:opacity-40"
          >
            ‹ 이전
          </button>
          <span className="min-w-[90px] text-center text-sm font-semibold text-foreground">
            {year}년 {month}월
          </span>
          <button
            type="button"
            onClick={() => goMonth(1)}
            disabled={busy || isMaxMonth}
            className="rounded-[8px] border border-neutral-300/70 bg-white/55 px-3 py-1.5 text-xs font-medium hover:bg-white/90 disabled:opacity-40"
          >
            다음 ›
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error ? (
            <p className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
          ) : null}
          {busy ? (
            <p className="py-12 text-center text-sm text-neutral-400">불러오는 중…</p>
          ) : rows.length === 0 ? (
            <p className="py-12 text-center text-sm text-neutral-400">이 달의 출결 기록이 없습니다.</p>
          ) : (
            <ul className="space-y-1.5">
              {rows.map((r) => {
                const deductible = r.reason === "illness" || r.reason === "academy";
                const confirming = confirmDate === r.date;
                return (
                  <li
                    key={r.date}
                    className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 ${
                      deductible
                        ? "bg-amber-50/80 ring-1 ring-amber-200/70 dark:bg-amber-900/15"
                        : "bg-white/50 dark:bg-white/[0.06]"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-medium text-foreground">
                          {formatRecordDate(r.date)}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            r.status === "present"
                              ? "bg-emerald-500/15 text-emerald-900 dark:text-emerald-200"
                              : "bg-neutral-500/15 text-neutral-800 dark:text-neutral-200"
                          }`}
                        >
                          {r.status === "present" ? "출석" : "결석"}
                        </span>
                        {r.reason ? (
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              deductible
                                ? "bg-amber-500/25 text-amber-950 dark:text-amber-200"
                                : "bg-neutral-500/10 text-neutral-600 dark:text-neutral-300"
                            }`}
                          >
                            {ABSENCE_REASON_LABELS[r.reason]}
                          </span>
                        ) : null}
                        <span className="text-[10px] text-neutral-500">{roleLabel(r.recordedByRole)}</span>
                      </div>
                      {r.note ? (
                        <p className="mt-0.5 truncate text-[11px] text-neutral-600">{r.note}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      {confirming ? (
                        <>
                          <button
                            type="button"
                            disabled={deleteBusy}
                            className="rounded-[8px] border border-neutral-300/70 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-neutral-700 hover:bg-white disabled:opacity-50"
                            onClick={() => setConfirmDate(null)}
                          >
                            아니요
                          </button>
                          <button
                            type="button"
                            disabled={deleteBusy}
                            className="rounded-[8px] border border-red-300 bg-red-500 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-red-600 disabled:opacity-50"
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
                              className="rounded-[8px] border border-neutral-300/70 bg-white/70 px-2.5 py-1 text-[11px] font-medium text-neutral-700 hover:bg-white/90 disabled:opacity-40"
                              onClick={() => setEditTarget(r)}
                            >
                              사유
                            </button>
                          ) : null}
                          <button
                            type="button"
                            disabled={deleteBusy}
                            className="rounded-[8px] border border-red-200/80 bg-white/70 px-2.5 py-1 text-[11px] font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
                            onClick={() => setConfirmDate(r.date)}
                          >
                            삭제
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

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
            onNotice(message);
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
            onNotice(message);
            void fetchRows();
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}
