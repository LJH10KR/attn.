"use client";

import { useCallback, useEffect, useState } from "react";
import { ProcessStatusModal } from "@/components/ui/process-status-modal";

const PIN_LEN = 4;

function shuffleDigits(): string[] {
  const digits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
  for (let i = digits.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = digits[i]!;
    digits[i] = digits[j]!;
    digits[j] = a;
  }
  return digits;
}

/** 3×3 숫자 + 하단(빈칸·숫자·⌫) — 숫자 배치는 매번 무작위 */
function buildShuffledKeypad(): string[] {
  const shuffled = shuffleDigits();
  return [
    shuffled[0]!,
    shuffled[1]!,
    shuffled[2]!,
    shuffled[3]!,
    shuffled[4]!,
    shuffled[5]!,
    shuffled[6]!,
    shuffled[7]!,
    shuffled[8]!,
    "",
    shuffled[9]!,
    "⌫",
  ];
}

export type PinPadModalProps = {
  open: boolean;
  title: string;
  description?: string;
  error?: string | null;
  busy?: boolean;
  busyTitle?: string;
  busyDescription?: string;
  /** 단계가 바뀔 때마다 바뀌는 값 — 입력란·키패드 배치 초기화 */
  phaseKey?: string | number;
  onCloseAction: () => void;
  onCompleteAction: (pin: string) => void;
};

export function PinPadModal({
  open,
  title,
  description,
  error,
  busy = false,
  busyTitle = "처리 중...",
  busyDescription,
  phaseKey = 0,
  onCloseAction,
  onCompleteAction,
}: PinPadModalProps) {
  const [digits, setDigits] = useState("");
  const [keypadKeys, setKeypadKeys] = useState(() => buildShuffledKeypad());

  useEffect(() => {
    if (!open) {
      setDigits("");
      return;
    }
    setDigits("");
    setKeypadKeys(buildShuffledKeypad());
  }, [open, phaseKey]);

  const append = useCallback(
    (d: string) => {
      if (busy) return;
      setDigits((prev) => {
        if (prev.length >= PIN_LEN) return prev;
        const next = prev + d;
        if (next.length === PIN_LEN) {
          queueMicrotask(() => {
            setDigits("");
            onCompleteAction(next);
          });
        }
        return next;
      });
    },
    [busy, onCompleteAction],
  );

  const backspace = useCallback(() => {
    if (busy) return;
    setDigits((prev) => prev.slice(0, -1));
  }, [busy]);

  if (!open) return null;

  if (busy) {
    return (
      <ProcessStatusModal
        open={true}
        title={busyTitle}
        description={busyDescription}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pin-pad-title"
    >
      <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-xl dark:bg-neutral-900">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="pin-pad-title" className="text-lg font-semibold text-foreground">
              {title}
            </h2>
            {description ? (
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onCloseAction}
            className="shrink-0 rounded-full px-2 py-1 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
          >
            닫기
          </button>
        </div>

        <div
          className="mt-6 flex justify-center gap-3"
          aria-label={`${PIN_LEN}자리 PIN 입력`}
        >
          {Array.from({ length: PIN_LEN }).map((_, i) => (
            <span
              key={i}
              className={`flex h-12 w-10 items-center justify-center rounded-xl border text-xl font-semibold ${
                i < digits.length
                  ? "border-[#222] bg-[#222] text-white dark:border-white/30 dark:bg-neutral-100 dark:text-neutral-950"
                  : "border-neutral-200 bg-neutral-50 dark:border-white/15 dark:bg-white/5"
              }`}
            >
              {i < digits.length ? "•" : ""}
            </span>
          ))}
        </div>

        {error ? (
          <p className="mt-3 text-center text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : null}

        <div className="mt-6 grid grid-cols-3 gap-2">
          {keypadKeys.map((key, idx) => {
            if (key === "") {
              return <div key={`spacer-${idx}`} aria-hidden />;
            }
            const isBack = key === "⌫";
            return (
              <button
                key={`${key}-${idx}`}
                type="button"
                onClick={() => (isBack ? backspace() : append(key))}
                className="flex h-12 items-center justify-center rounded-2xl bg-neutral-100 text-lg font-medium text-foreground transition hover:bg-neutral-200 dark:bg-white/10 dark:hover:bg-white/15"
              >
                {key}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
