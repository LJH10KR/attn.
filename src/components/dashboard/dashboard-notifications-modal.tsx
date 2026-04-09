"use client";

import { useEffect } from "react";

const glassCard = "glass-card";

export type DashboardNotificationRow = {
  id: string;
  title: string;
  detail?: string;
};

type DashboardNotificationsModalProps = {
  open: boolean;
  onClose: () => void;
  heading: string;
  items: DashboardNotificationRow[];
  emptyLabel: string;
};

export function DashboardNotificationsModal({
  open,
  onClose,
  heading,
  items,
  emptyLabel,
}: DashboardNotificationsModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[50] flex items-center justify-center bg-black/35 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dashboard-notifications-modal-title"
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="닫기"
        onClick={onClose}
      />
      <div
        className={`relative z-[51] w-full max-w-md max-h-[min(28rem,calc(100dvh-2rem))] min-h-0 overflow-hidden rounded-[1.75rem] border border-white/60 bg-[rgba(252,251,248,0.98)] shadow-[0_24px_80px_-20px_rgba(0,0,0,0.22)] backdrop-blur-xl dark:border-white/12 dark:bg-neutral-900/95`}
      >
        <div className="flex items-center justify-between border-b border-neutral-200/70 px-5 py-4 dark:border-white/10">
          <h2
            id="dashboard-notifications-modal-title"
            className="text-base font-semibold text-foreground"
          >
            {heading}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-black/[0.06] dark:text-neutral-300 dark:hover:bg-white/10"
          >
            닫기
          </button>
        </div>
        <div className="max-h-[min(22rem,calc(100dvh-8rem))] overflow-y-auto px-3 py-3">
          {items.length === 0 ? (
            <p className="px-2 py-10 text-center text-sm text-neutral-500">{emptyLabel}</p>
          ) : (
            <ul className="space-y-2">
              {items.map((row) => (
                <li key={row.id} className={`rounded-2xl px-4 py-3 ${glassCard}`}>
                  <p className="text-sm font-medium text-foreground">{row.title}</p>
                  {row.detail ? (
                    <p className="mt-1 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
                      {row.detail}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export function formatDashboardBellBadge(count: number): string {
  if (count <= 0) return "";
  if (count > 99) return "99+";
  return String(count);
}
