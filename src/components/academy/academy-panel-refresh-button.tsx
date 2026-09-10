"use client";

/** 학원 관리 패널 — 알림 기록 탭과 동일한 새로고침 스타일 */
export function AcademyPanelRefreshButton({
  busy,
  onRefreshAction,
  label = "새로고침",
}: {
  busy: boolean;
  onRefreshAction: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onRefreshAction}
      disabled={busy}
      className="shrink-0 rounded-[8px] border border-neutral-300/80 bg-white/70 px-3 py-2 text-[11px] font-medium text-neutral-800 hover:bg-white disabled:opacity-50 dark:border-white/12 dark:bg-white/[0.08] dark:text-neutral-200 dark:hover:bg-white/15"
    >
      {busy ? "불러오는 중…" : label}
    </button>
  );
}
