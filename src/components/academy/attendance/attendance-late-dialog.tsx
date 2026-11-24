"use client";

import { useEffect, useState } from "react";
import { ModalPortal } from "@/components/ui/modal-portal";
import {
  isLateMinutes,
  LATE_MINUTES_MAX,
  LATE_MINUTES_MESSAGE,
  LATE_MINUTES_MIN,
} from "@/lib/academy/attendance-rules";

const PRESETS = [5, 10, 15, 20, 30] as const;

export type LateDialogTarget = {
  studentId: string;
  studentName: string;
  classId: string;
  className: string;
  /** 이미 지각이면 지금 분(없으면 null) */
  current: number | null;
  /** 이미 지각 기록이 있는지 */
  isLate: boolean;
  /** 미리 채움(화면에서만 — 등원 시각 − 첫 수업 시작, 1~180분일 때만, B1 ②) */
  suggested: number | null;
};

/**
 * 3-B 지각 창(B1 ②) — 분 버튼 5·10·15·20·30 + 직접 입력(1~180).
 * 이미 지각이면 [지각 기록 취소/지우기]·[분 바꾸기], 지난 날짜도 같은 창(정정 — 알림 없음).
 * 분만 바꾸면 알림 없이 정정 기록이 남는다(★2). 미리 채운 값은 화면 제안일 뿐 서버는 판정하지 않는다.
 */
export function AttendanceLateDialog({
  target,
  past,
  onSubmitAction,
  onClearAction,
  onCloseAction,
}: {
  target: LateDialogTarget;
  past: boolean;
  onSubmitAction: (minutes: number) => void;
  /** 지각 기록 취소(오늘 = 취소 확인 창, 지난 날짜 = 지우기 확인 창) */
  onClearAction: () => void;
  onCloseAction: () => void;
}) {
  const initial = target.current ?? target.suggested;
  const [text, setText] = useState(initial !== null ? String(initial) : "");
  const [error, setError] = useState<string | null>(null);
  const minutes = text.trim() === "" ? NaN : Number(text);
  const valid = isLateMinutes(minutes);
  const unchanged = target.isLate && valid && minutes === target.current;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseAction();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCloseAction]);

  const submit = () => {
    if (!valid) {
      setError(LATE_MINUTES_MESSAGE);
      return;
    }
    onSubmitAction(minutes);
  };

  const notice = past
    ? "지난 날짜 정정이에요. 학부모 알림은 가지 않고 정정 기록이 남습니다."
    : target.isLate
      ? "지각 시간만 바꾸면 학부모 알림은 가지 않고 정정 기록이 남습니다."
      : "학부모에게 지각 알림이 갑니다(출결 설정에서 끈 알림은 기록만 남습니다).";

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[260] flex items-end justify-center bg-black/40 sm:items-center"
        role="presentation"
        onClick={onCloseAction}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="attendance-late-title"
          className="w-full max-w-lg rounded-t-3xl bg-white p-5 pb-[calc(max(1.25rem,env(safe-area-inset-bottom))+30px)] shadow-2xl sm:rounded-3xl sm:pb-5"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 id="attendance-late-title" className="break-keep text-base font-semibold text-foreground">
            {target.studentName} {target.className} 지각{target.isLate ? " 바꾸기" : ""}
          </h2>
          <p className="mt-1 break-keep text-xs text-neutral-500">{notice}</p>

          <p className="mt-4 text-[11px] font-medium text-neutral-600">몇 분 늦었나요?</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {PRESETS.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={minutes === m}
                onClick={() => {
                  setText(String(m));
                  setError(null);
                }}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
                  minutes === m ? "border-violet-600 bg-violet-600 text-white" : "border-neutral-300/80 bg-white text-neutral-800"
                }`}
              >
                {m}분
              </button>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <label htmlFor="late-minutes" className="shrink-0 text-[11px] text-neutral-600">
              직접 입력
            </label>
            <input
              id="late-minutes"
              type="number"
              inputMode="numeric"
              min={LATE_MINUTES_MIN}
              max={LATE_MINUTES_MAX}
              value={text}
              onChange={(e) => {
                setText(e.target.value.replace(/[^0-9]/g, ""));
                setError(null);
              }}
              className="w-24 rounded-xl border border-neutral-300/80 bg-white px-2.5 py-1.5 text-sm"
              placeholder="분"
            />
            <span className="text-[11px] text-neutral-500">분 ({LATE_MINUTES_MIN}~{LATE_MINUTES_MAX})</span>
          </div>
          {target.suggested !== null && target.current === null ? (
            <p className="mt-1.5 text-[10px] text-neutral-400">등원 시각과 수업 시작으로 미리 채웠어요. 바꿀 수 있습니다.</p>
          ) : null}
          {error ? (
            <p className="mt-2 break-keep text-xs text-red-700" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-4 flex gap-2">
            {target.isLate ? (
              <button
                type="button"
                onClick={onClearAction}
                className="flex-1 rounded-2xl border border-red-200 py-3 text-sm font-medium text-red-600"
              >
                지각 기록 {past ? "지우기" : "취소"}
              </button>
            ) : (
              <button
                type="button"
                onClick={onCloseAction}
                className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium"
              >
                닫기
              </button>
            )}
            <button
              type="button"
              disabled={!valid || unchanged}
              onClick={submit}
              className="flex-1 rounded-2xl bg-violet-700 py-3 text-sm font-medium text-white disabled:opacity-40"
            >
              {target.isLate ? "분 바꾸기" : "지각 기록"}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
