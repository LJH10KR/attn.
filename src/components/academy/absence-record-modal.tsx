import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ABSENCE_REASON_LABELS,
  ABSENCE_REASONS,
  type AbsenceReason,
} from "@/lib/firebase/attn-schema";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import {
  describeNotifyResult,
  enumerateDates,
  formatRecordDate,
  isWeekend,
  MAX_ABSENCE_DATES_PER_REQUEST,
  MAX_ABSENCE_NOTE_LENGTH,
  MAX_FUTURE_DAYS,
  MAX_PAST_DAYS,
  seoulDateOffset,
  seoulDateString,
} from "@/lib/academy/attendance-records";
import { SlideSwitch } from "@/components/ui/slide-switch";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

const inputClass =
  "min-w-0 w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-3 py-2 text-sm text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50 focus:bg-white/70";

const REASON_HINTS: Record<AbsenceReason, string> = {
  general: "학생·가정 사정 등 일반 결석입니다.",
  illness: "전염성 질병 등으로 학원이 등원을 제한한 결석입니다. 원비 차감 대상으로 표시됩니다.",
  academy: "휴원 등 학원 사정으로 수업이 없었던 날입니다. 원비 차감 대상으로 표시됩니다.",
};

type RecordAbsencesResult = {
  recordedCount?: number;
  notification?: Parameters<typeof describeNotifyResult>[0];
};

/**
 * 원장·학원 포털 — 결석 사유와 날짜(오늘 또는 기간)를 지정해 기록. `recordStudentAbsences` 호출.
 * 기간 선택 시 주말은 기본 해제되며, 날짜별로 켜고 끌 수 있음.
 */
export function AbsenceRecordModal({
  academyId,
  studentId,
  studentName,
  initialDate,
  initialReason = "general",
  initialNote = "",
  onClose,
  onSaved,
}: {
  academyId: string;
  studentId: string;
  studentName: string;
  /** 지정 시 해당 날짜 하나만 기록(사유 변경용) */
  initialDate?: string;
  initialReason?: AbsenceReason;
  initialNote?: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const today = seoulDateString();
  const [reason, setReason] = useState<AbsenceReason>(initialReason);
  const [mode, setMode] = useState<"today" | "range">("today");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [note, setNote] = useState(initialNote);
  const [notifyParent, setNotifyParent] = useState(!initialDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useBodyScrollLock(true);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const rangeDates = useMemo(() => {
    if (initialDate) return [initialDate];
    return mode === "today" ? [today] : enumerateDates(startDate, endDate);
  }, [initialDate, mode, today, startDate, endDate]);

  // 기간이 바뀌면 주말을 기본 제외 상태로 다시 맞춤
  useEffect(() => {
    if (mode !== "range" || initialDate) return;
    setExcluded(new Set(rangeDates.filter(isWeekend)));
  }, [initialDate, mode, rangeDates]);

  const selectedDates = useMemo(
    () => rangeDates.filter((d) => !excluded.has(d)),
    [rangeDates, excluded],
  );

  const rangeTooLong = rangeDates.length > MAX_ABSENCE_DATES_PER_REQUEST;
  const rangeInvalid = mode === "range" && rangeDates.length === 0;
  const canSubmit = !busy && !rangeTooLong && !rangeInvalid && selectedDates.length > 0;

  const toggleDate = (d: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "recordStudentAbsences");
      const res = await fn({
        academyId,
        studentId,
        dates: selectedDates,
        reason,
        note: note.trim(),
        notifyParent,
      });
      const data = (res.data ?? {}) as RecordAbsencesResult;
      const count = data.recordedCount ?? selectedDates.length;
      onSaved(
        `${studentName} 결석 ${count}일(${ABSENCE_REASON_LABELS[reason]})을 기록했습니다.${describeNotifyResult(
          data.notification ?? null,
        )}`,
      );
    } catch (e) {
      setError(
        e instanceof FirebaseError && e.message ? e.message : "결석을 기록하지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="absence-record-title"
        className="glass-card flex w-full max-w-md flex-col shadow-2xl"
        style={{ maxHeight: "min(90dvh, 720px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-neutral-200/60 px-5 py-4 dark:border-white/10">
          <h2 id="absence-record-title" className="text-base font-semibold text-foreground">
            {initialDate ? "결석 사유 변경" : "결석 기록"}
          </h2>
          <p className="mt-0.5 text-xs text-neutral-600">
            대상: <span className="font-medium text-foreground">{studentName}</span>
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <section>
            <p className="mb-1.5 text-xs font-semibold text-foreground">사유</p>
            <div className="grid grid-cols-3 gap-1.5">
              {ABSENCE_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  disabled={busy}
                  onClick={() => setReason(r)}
                  aria-pressed={reason === r}
                  className={`rounded-[10px] border px-2 py-2 text-xs font-medium disabled:opacity-50 ${
                    reason === r
                      ? r === "general"
                        ? "border-neutral-700 bg-neutral-800 text-white dark:border-neutral-200 dark:bg-neutral-100 dark:text-neutral-950"
                        : "border-amber-500 bg-amber-500 text-white"
                      : "border-neutral-300/70 bg-white/55 text-foreground hover:bg-white/90"
                  }`}
                >
                  {ABSENCE_REASON_LABELS[r]}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-neutral-500">{REASON_HINTS[reason]}</p>
          </section>

          {initialDate ? (
            <section>
              <p className="mb-1.5 text-xs font-semibold text-foreground">날짜</p>
              <p className="text-sm text-foreground">{formatRecordDate(initialDate)}</p>
            </section>
          ) : (
            <section>
              <p className="mb-1.5 text-xs font-semibold text-foreground">날짜</p>
              <div className="mb-2 grid grid-cols-2 gap-1.5">
                {(["today", "range"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    disabled={busy}
                    onClick={() => setMode(m)}
                    aria-pressed={mode === m}
                    className={`rounded-[10px] border px-2 py-2 text-xs font-medium disabled:opacity-50 ${
                      mode === m
                        ? "border-neutral-700 bg-neutral-800 text-white dark:border-neutral-200 dark:bg-neutral-100 dark:text-neutral-950"
                        : "border-neutral-300/70 bg-white/55 text-foreground hover:bg-white/90"
                    }`}
                  >
                    {m === "today" ? `오늘 (${formatRecordDate(today)})` : "기간 선택"}
                  </button>
                ))}
              </div>

              {mode === "range" ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[11px] text-neutral-600">
                      시작일
                      <input
                        type="date"
                        className={`${inputClass} mt-1`}
                        value={startDate}
                        min={seoulDateOffset(-MAX_PAST_DAYS)}
                        max={seoulDateOffset(MAX_FUTURE_DAYS)}
                        disabled={busy}
                        onChange={(e) => {
                          setStartDate(e.target.value);
                          if (e.target.value > endDate) setEndDate(e.target.value);
                        }}
                      />
                    </label>
                    <label className="text-[11px] text-neutral-600">
                      종료일
                      <input
                        type="date"
                        className={`${inputClass} mt-1`}
                        value={endDate}
                        min={startDate}
                        max={seoulDateOffset(MAX_FUTURE_DAYS)}
                        disabled={busy}
                        onChange={(e) => setEndDate(e.target.value)}
                      />
                    </label>
                  </div>

                  {rangeTooLong ? (
                    <p className="mt-2 text-[11px] text-red-600">
                      한 번에 최대 {MAX_ABSENCE_DATES_PER_REQUEST}일까지 기록할 수 있습니다.
                    </p>
                  ) : rangeInvalid ? (
                    <p className="mt-2 text-[11px] text-red-600">날짜를 다시 선택해 주세요.</p>
                  ) : (
                    <>
                      <p className="mt-2 text-[11px] text-neutral-500">
                        수업이 없는 날은 눌러서 제외하세요. 주말은 기본 제외됩니다. (선택{" "}
                        {selectedDates.length}일)
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {rangeDates.map((d) => {
                          const on = !excluded.has(d);
                          return (
                            <button
                              key={d}
                              type="button"
                              disabled={busy}
                              onClick={() => toggleDate(d)}
                              aria-pressed={on}
                              className={`rounded-full border px-2 py-1 text-[10px] font-medium disabled:opacity-50 ${
                                on
                                  ? "border-amber-400/70 bg-amber-500/15 text-amber-950 dark:text-amber-200"
                                  : "border-neutral-300/60 bg-transparent text-neutral-400 line-through"
                              }`}
                            >
                              {formatRecordDate(d)}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </>
              ) : null}
            </section>
          )}

          <section>
            <label className="text-xs font-semibold text-foreground" htmlFor="absence-note">
              메모 <span className="font-normal text-neutral-500">(선택)</span>
            </label>
            <input
              id="absence-note"
              type="text"
              className={`${inputClass} mt-1.5`}
              value={note}
              maxLength={MAX_ABSENCE_NOTE_LENGTH}
              placeholder="예: 수족구 — 완치 확인 후 등원"
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
            />
          </section>

          <section className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-foreground">학부모에게 알림 보내기</p>
              <p className="text-[11px] text-neutral-500">
                여러 날을 기록해도 알림은 1건만 보냅니다.
              </p>
            </div>
            <SlideSwitch
              checked={notifyParent}
              onCheckedChangeAction={setNotifyParent}
              disabled={busy}
              ariaLabel="학부모에게 알림 보내기"
            />
          </section>

          {error ? (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-200/60 px-5 py-3 dark:border-white/10">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            className="rounded-2xl border border-neutral-300/80 bg-white/80 px-4 py-2.5 text-sm font-medium text-neutral-800 disabled:opacity-50"
            onClick={onClose}
          >
            취소
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            className="rounded-2xl bg-[#222] dark:bg-neutral-100 px-4 py-2.5 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-50"
            onClick={() => void submit()}
          >
            {busy
              ? "기록 중…"
              : initialDate
                ? "변경"
                : `결석 ${selectedDates.length}일 기록`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
