"use client";

import { useMemo, useState } from "react";

const DAY_MS = 24 * 60 * 60 * 1000;

function seoulMidnightMs(date: Date): number {
  const dateStr = date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  return new Date(`${dateStr}T00:00:00+09:00`).getTime();
}

function getNextDueDateMs(dueDayOfMonth: number, todayMidnightMs: number): number {
  const todayStr = new Date(todayMidnightMs).toLocaleDateString("en-CA", {
    timeZone: "Asia/Seoul",
  });
  const [y, m] = todayStr.split("-").map(Number) as [number, number];

  const daysInCurrent = new Date(y, m, 0).getDate();
  const currentDay = Math.min(dueDayOfMonth, daysInCurrent);
  const currentDueMs = new Date(
    `${y}-${String(m).padStart(2, "0")}-${String(currentDay).padStart(2, "0")}T00:00:00+09:00`,
  ).getTime();

  if (currentDueMs >= todayMidnightMs) return currentDueMs;

  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  const daysInNext = new Date(ny, nm, 0).getDate();
  const nextDay = Math.min(dueDayOfMonth, daysInNext);
  return new Date(
    `${ny}-${String(nm).padStart(2, "0")}-${String(nextDay).padStart(2, "0")}T00:00:00+09:00`,
  ).getTime();
}

type TuitionSettings = {
  kakaoPayLink?: string;
  bankName?: string;
  accountNumber?: string;
  accountHolder?: string;
};

type Props = {
  tuitionDueDayOfMonth: number;
  tuitionAmount?: number | null;
  settings: TuitionSettings | null;
};

export function ParentTuitionReminderCard({
  tuitionDueDayOfMonth,
  tuitionAmount,
  settings,
}: Props) {
  const [copied, setCopied] = useState(false);

  const { diffDays, dueDateLabel } = useMemo(() => {
    const todayMs = seoulMidnightMs(new Date());
    const nextDueMs = getNextDueDateMs(tuitionDueDayOfMonth, todayMs);
    const diff = Math.round((nextDueMs - todayMs) / DAY_MS);
    const label = new Date(nextDueMs).toLocaleDateString("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    return { diffDays: diff, dueDateLabel: label };
  }, [tuitionDueDayOfMonth]);

  // D-7 ~ D-0 (당일 포함) 구간에만 표시
  if (diffDays < 0 || diffDays > 7) return null;

  const diffLabel = diffDays === 0 ? "D-Day" : `D-${diffDays}`;

  const hasBankInfo =
    settings?.bankName || settings?.accountNumber || settings?.accountHolder;
  const accountText = [
    settings?.bankName,
    settings?.accountNumber,
    settings?.accountHolder,
  ]
    .filter(Boolean)
    .join(" · ");

  const onCopy = async () => {
    if (!settings?.accountNumber) return;
    try {
      await navigator.clipboard.writeText(settings.accountNumber);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="mt-3 rounded-2xl bg-amber-50/80 dark:bg-amber-900/20 ring-1 ring-amber-200/70 dark:ring-amber-700/40 p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold text-amber-800 dark:text-amber-300 bg-amber-200/60 dark:bg-amber-800/50 px-2 py-0.5 rounded-full">
          {diffLabel}
        </span>
        <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
          원비 납부 안내
        </p>
      </div>

      <div className="space-y-0.5">
        <p className="text-[11px] text-amber-800 dark:text-amber-300">
          납부 예정일{" "}
          <span className="font-medium text-amber-950 dark:text-amber-100">
            {dueDateLabel}
          </span>
        </p>
        {tuitionAmount != null ? (
          <p className="text-[11px] text-amber-800 dark:text-amber-300">
            납부 금액{" "}
            <span className="font-medium text-amber-950 dark:text-amber-100">
              {tuitionAmount.toLocaleString("ko-KR")}원
            </span>
          </p>
        ) : null}
      </div>

      {settings?.kakaoPayLink ? (
        <a
          href={settings.kakaoPayLink}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center w-full rounded-[18px] bg-[#FEE500] py-2.5 text-xs font-semibold text-[#3C1E1E] hover:bg-[#F6D800] active:bg-[#EDD000]"
        >
          카카오페이로 납부하기
        </a>
      ) : null}

      {hasBankInfo ? (
        <div className="flex items-center justify-between gap-2 rounded-xl bg-white/60 dark:bg-white/10 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-[10px] text-neutral-500 dark:text-neutral-400">
              계좌번호
            </p>
            <p className="mt-0.5 text-xs font-medium text-foreground truncate">
              {accountText}
            </p>
          </div>
          {settings?.accountNumber ? (
            <button
              type="button"
              onClick={() => void onCopy()}
              className="shrink-0 rounded-[18px] border border-neutral-300/70 bg-white/70 dark:bg-white/10 px-2.5 py-1.5 text-[10px] font-medium text-neutral-700 dark:text-neutral-300 hover:bg-white/90"
            >
              {copied ? "복사됨" : "복사"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
