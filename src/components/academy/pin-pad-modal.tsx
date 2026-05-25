"use client";

import { useCallback, useEffect, useState } from "react";

const PIN_LEN = 4;

export type PinPadModalProps = {
  open: boolean;
  title: string;
  description?: string;
  error?: string | null;
  busy?: boolean;
  onCloseAction: () => void;
  onCompleteAction: (pin: string) => void;
};

export function PinPadModal({
  open,
  title,
  description,
  error,
  busy = false,
  onCloseAction,
  onCompleteAction,
}: PinPadModalProps) {
  const [digits, setDigits] = useState("");

  useEffect(() => {
    if (!open) setDigits("");
  }, [open]);

  const append = useCallback(
    (d: string) => {
      if (busy) return;
      setDigits((prev) => {
        if (prev.length >= PIN_LEN) return prev;
        const next = prev + d;
        if (next.length === PIN_LEN) {
          queueMicrotask(() => onCompleteAction(next));
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
            disabled={busy}
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
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((key) => {
            if (key === "") {
              return <div key="spacer" />;
            }
            const isBack = key === "⌫";
            return (
              <button
                key={key}
                type="button"
                disabled={busy}
                onClick={() => (isBack ? backspace() : append(key))}
                className="flex h-12 items-center justify-center rounded-2xl bg-neutral-100 text-lg font-medium text-foreground transition hover:bg-neutral-200 disabled:opacity-50 dark:bg-white/10 dark:hover:bg-white/15"
              >
                {key}
              </button>
            );
          })}
        </div>

        {busy ? (
          <p className="mt-4 text-center text-xs text-neutral-500">처리 중…</p>
        ) : null}
      </div>
    </div>
  );
}
