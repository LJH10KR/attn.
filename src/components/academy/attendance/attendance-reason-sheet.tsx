"use client";

import { useEffect, useState } from "react";
import { ModalPortal } from "@/components/ui/modal-portal";
import {
  ABSENCE_REASONS,
  ABSENCE_REASON_LABELS,
  ATTENDANCE_NOTE_MAX_LENGTH,
  dateLabel,
  type AbsenceReason,
} from "@/lib/academy/attendance-rules";
import { useAttendanceCorrections } from "@/lib/academy/use-attendance-corrections";

/**
 * 학생 상세 출결 탭 "사유"(3-A ★8) — 미등원 기록의 사유·메모를 **기록을 유지한 채** 바꾼다(`updateAttendanceDetails`).
 * 알림 없음·정정 이력. 예전에는 기간 결석 창으로 다시 써서 메모가 지워질 수 있었다.
 * 차감 잠금 날은 사유를 바꿀 수 없고 메모만 저장된다(★4).
 */
export function AttendanceReasonSheet({
  academyId,
  studentId,
  studentName,
  date,
  reason,
  note,
  billed,
  onSavedAction,
  onCloseAction,
}: {
  academyId: string;
  studentId: string;
  studentName: string;
  date: string;
  reason: AbsenceReason | null;
  note: string;
  billed: boolean;
  onSavedAction: (message: string) => void;
  onCloseAction: () => void;
}) {
  const [nextReason, setNextReason] = useState<AbsenceReason>(reason ?? "general");
  const [nextNote, setNextNote] = useState(note);
  const [error, setError] = useState<string | null>(null);
  const { busyKey, updateDetails } = useAttendanceCorrections(academyId);
  const busy = busyKey !== null;
  const reasonChanged = nextReason !== (reason ?? "general");
  const noteChanged = nextNote.trim() !== note.trim();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onCloseAction();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onCloseAction]);

  const save = async () => {
    setError(null);
    const o = await updateDetails({
      layer: "arrival",
      studentId,
      date,
      ...(reasonChanged ? { reason: nextReason } : {}),
      ...(noteChanged ? { note: nextNote } : {}),
      via: "student_detail",
    });
    if (!o.ok) {
      setError(o.message);
      return;
    }
    onSavedAction(`${studentName} ${dateLabel(date)} 미등원 사유·메모를 저장했습니다.`);
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[260] flex items-end justify-center bg-black/40 sm:items-center"
        role="presentation"
        onClick={() => (busy ? undefined : onCloseAction())}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="attendance-reason-title"
          className="w-full max-w-lg rounded-t-3xl bg-white p-5 pb-[calc(max(1.25rem,env(safe-area-inset-bottom))+30px)] shadow-2xl sm:rounded-3xl sm:pb-5"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 id="attendance-reason-title" className="text-base font-semibold text-foreground">
            {studentName} · {dateLabel(date)} 미등원
          </h2>
          <p className="mt-1 break-keep text-xs text-neutral-500">
            기록은 그대로 두고 사유·메모만 바꿉니다. 학부모 알림은 가지 않고 정정 기록이 남습니다.
          </p>
          <p className="mb-1.5 mt-4 text-xs font-medium text-neutral-700">사유</p>
          <div className="flex flex-wrap gap-1.5">
            {ABSENCE_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={nextReason === r}
                disabled={busy || billed}
                onClick={() => setNextReason(r)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${
                  nextReason === r ? "border-[#222] bg-[#222] text-white" : "border-neutral-300 bg-white text-neutral-700"
                }`}
              >
                {ABSENCE_REASON_LABELS[r]}
              </button>
            ))}
          </div>
          {billed ? (
            <p className="mt-1.5 break-keep text-[11px] text-sky-800">
              청구서 결석 차감에 반영된 날이라 사유는 바꿀 수 없습니다(메모는 저장 가능).
            </p>
          ) : null}
          <div className="mb-1 mt-4 flex items-center justify-between">
            <label htmlFor="attendance-reason-note" className="text-xs font-medium text-neutral-700">
              메모
            </label>
            <span className="text-[10px] text-neutral-400">
              {nextNote.length}/{ATTENDANCE_NOTE_MAX_LENGTH}
            </span>
          </div>
          <textarea
            id="attendance-reason-note"
            rows={3}
            maxLength={ATTENDANCE_NOTE_MAX_LENGTH}
            value={nextNote}
            onChange={(e) => setNextNote(e.target.value)}
            className="w-full resize-none rounded-xl border border-neutral-300 px-3 py-2 text-sm"
          />
          {error ? (
            <p className="mt-2 break-keep text-sm text-red-700" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onCloseAction}
              className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium disabled:opacity-50"
            >
              닫기
            </button>
            <button
              type="button"
              disabled={busy || (!reasonChanged && !noteChanged)}
              onClick={() => void save()}
              className="flex-1 rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "저장하는 중…" : "저장"}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
