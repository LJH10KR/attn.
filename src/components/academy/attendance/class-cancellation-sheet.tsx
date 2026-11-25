"use client";

import { useEffect, useState } from "react";
import { ModalPortal } from "@/components/ui/modal-portal";
import {
  CLASS_CANCELLATION_MEMO_MAX_LENGTH,
  classCancellationBlock,
  classCancellationBlockMessage,
  dateLabel,
} from "@/lib/academy/attendance-rules";
import type { DayCancellation } from "@/lib/academy/day-roster";
import type { CallOutcome } from "@/lib/academy/use-attendance-corrections";

/** 휴강 저장·취소 성공 안내(원장 출결 화면·반 관리 목록 공용) */
export function classCancellationNotice(p: { className: string; date: string; cancelled: boolean; changed: boolean }): string {
  if (!p.changed) return "바뀐 내용이 없습니다.";
  return p.cancelled
    ? `${p.className} ${dateLabel(p.date)} 휴강을 저장했습니다. 학부모 알림은 가지 않습니다.`
    : `${p.className} ${dateLabel(p.date)} 휴강을 취소했습니다.`;
}

/**
 * 3-B 휴강 시트(B7·★11) — 원장 출결 화면 반 머리 [휴강], 반 관리 목록 카드 [휴강](3-B 후속 F3, 오늘만).
 * 학부모 알림 없음, 정정 기록이 남는다.
 * 없으면 메모(선택)와 함께 기록, 있으면 메모 바꾸기·휴강 취소. 그날 그 반 출결이 있으면 기록할 수 없다(서버도 거부).
 * 미래 날짜 휴강은 넘김(3-E/4단계).
 */
export function ClassCancellationSheet({
  date,
  today,
  className,
  classExists,
  classEnded,
  hasLesson,
  recordCount,
  cancellation,
  onSubmitAction,
  onCloseAction,
}: {
  date: string;
  today: string;
  className: string;
  classExists: boolean;
  classEnded: boolean;
  hasLesson: boolean;
  /**
   * 그날 그 반 출결 기록 수(화면이 아는 값 — 실제 판단은 서버).
   * null = 모름(반 관리 목록) — 화면에서 미리 막지 않고, 출결이 있으면 서버 거부 문구를 시트 안에 보여 준다.
   */
  recordCount: number | null;
  cancellation: DayCancellation | null;
  /** cancelled false = 휴강 취소 */
  onSubmitAction: (p: { cancelled: boolean; memo?: string }) => Promise<CallOutcome>;
  onCloseAction: () => void;
}) {
  const [memo, setMemo] = useState(cancellation?.memo ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exists = cancellation !== null;
  const block = exists
    ? null
    : classCancellationBlock({ date, today, classExists, classEnded, hasLesson, recordCount: recordCount ?? 0 });

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

  const run = async (p: { cancelled: boolean; memo?: string }) => {
    setBusy(true);
    setError(null);
    const o = await onSubmitAction(p);
    if (o.ok) {
      onCloseAction();
      return;
    }
    setError(o.message);
    setBusy(false);
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[220] flex items-end justify-center bg-black/40 sm:items-center"
        role="presentation"
        onClick={() => (busy ? undefined : onCloseAction())}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="class-cancellation-title"
          className="w-full max-w-lg rounded-t-3xl bg-white p-5 pb-sheet-5 shadow-2xl sm:rounded-3xl"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 id="class-cancellation-title" className="break-keep text-base font-semibold text-foreground">
            {dateLabel(date)} {className} {exists ? "휴강" : "휴강으로 기록할까요?"}
          </h2>
          <p className="mt-1 break-keep text-xs text-neutral-500">
            학부모 알림은 가지 않고 정정 기록이 남습니다. 휴강한 수업은 출결을 기록할 수 없고 요약 숫자에서 빠집니다.
          </p>
          {exists && cancellation.byName ? (
            <p className="mt-2 text-[11px] text-neutral-500">기록한 사람 · {cancellation.byName}</p>
          ) : null}

          {block ? (
            <p className="mt-3 break-keep rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-900">
              {classCancellationBlockMessage(block, { date, className, recordCount: recordCount ?? 0 })}
            </p>
          ) : (
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between">
                <label htmlFor="cancellation-memo" className="text-[11px] text-neutral-600">
                  메모(선택 · 학부모에게 보이지 않음)
                </label>
                <span className="text-[10px] text-neutral-400">
                  {memo.length}/{CLASS_CANCELLATION_MEMO_MAX_LENGTH}
                </span>
              </div>
              <textarea
                id="cancellation-memo"
                rows={2}
                maxLength={CLASS_CANCELLATION_MEMO_MAX_LENGTH}
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                className="w-full resize-none rounded-xl border border-neutral-300/80 bg-white px-2.5 py-1.5 text-sm"
                placeholder="예: 선생님 출장"
              />
            </div>
          )}
          {error ? (
            <p className="mt-2 break-keep text-xs text-red-700" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-4 flex gap-2">
            {exists ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run({ cancelled: false })}
                className="flex-1 rounded-2xl border border-red-200 py-3 text-sm font-medium text-red-600 disabled:opacity-50"
              >
                휴강 취소
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={onCloseAction}
                className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium disabled:opacity-50"
              >
                닫기
              </button>
            )}
            {block ? null : (
              <button
                type="button"
                disabled={busy || (exists && memo.trim() === (cancellation?.memo ?? "").trim())}
                onClick={() => void run({ cancelled: true, memo: memo.trim() })}
                className="flex-1 rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-40"
              >
                {busy ? "처리하는 중…" : exists ? "메모 저장" : "휴강 기록"}
              </button>
            )}
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
