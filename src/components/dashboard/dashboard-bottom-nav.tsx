"use client";

import { type ReactNode } from "react";

/** 계정 메뉴(프로필 버튼) 항목 — DashboardTopHeader로 이동했지만 타입은 여기서 계속 export */
export type DashboardBottomNavMenuAction = {
  label: string;
  onSelectAction: () => void;
  disabled?: boolean;
};

/** 하단 캡슐 바의 탭 한 칸 */
export type DashboardBottomNavTab = {
  id: string;
  label: string;
  iconAction: (active: boolean) => ReactNode;
  active: boolean;
  onSelectAction: () => void;
  showLabel?: boolean;
};

export type DashboardBottomNavProps = {
  title: string;
  showBack: boolean;
  onBackAction?: () => void;
  backAriaLabel?: string;
  backHint?: string;
  onHomeClickAction?: () => void;
  bottomTabs?: DashboardBottomNavTab[];
  includeSrOnlyScreenTitle?: boolean;
  className?: string;
};

function HomeIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H15v-5h-6v5H4a1 1 0 01-1-1V9.5z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BackChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path
        d="M15 6l-6 6 6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 대시보드 하단 고정 바: 탭(또는 홈) 캡슐.
 * 프로필·계정 메뉴는 DashboardTopHeader로 이동했습니다.
 */
export function DashboardBottomNav({
  title,
  showBack,
  onBackAction,
  backAriaLabel = "뒤로 가기",
  backHint,
  onHomeClickAction,
  bottomTabs,
  includeSrOnlyScreenTitle = true,
  className = "",
}: DashboardBottomNavProps) {
  return (
    <nav
      className={`fixed inset-x-0 bottom-[25px] z-30 mx-auto max-w-lg px-4 ${className}`}
      aria-label="대시보드 하단 메뉴"
    >
      {includeSrOnlyScreenTitle ? <p className="sr-only">{title}</p> : null}

      {showBack ? (
        <div className="mb-2 flex items-center gap-2">
          <button
            type="button"
            onClick={onBackAction}
            className="flex h-10 w-11 shrink-0 items-center justify-center rounded-2xl border border-neutral-300/55 bg-white/55 text-foreground shadow-[0_4px_14px_-4px_rgba(0,0,0,0.12)] backdrop-blur-md transition hover:bg-white/85 active:scale-[0.98] dark:border-white/12 dark:bg-white/10 dark:hover:bg-white/15"
            aria-label={backAriaLabel}
          >
            <BackChevronIcon />
          </button>
          {backHint ? (
            <span className="min-w-0 text-sm font-medium leading-snug text-foreground">
              {backHint}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* 메인 하단 캡슐 — 프로필 버튼 없이 full width */}
      <div
        className="flex h-[60px] w-full items-stretch overflow-hidden rounded-full bg-white/38 p-[2px] shadow-[0_12px_30px_-14px_rgba(0,0,0,0.10),0_-12px_30px_-14px_rgba(0,0,0,0.10),12px_0_30px_-14px_rgba(0,0,0,0.10),-12px_0_30px_-14px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.78)] dark:bg-white/10 dark:shadow-[0_14px_34px_-16px_rgba(0,0,0,0.36),0_-14px_34px_-16px_rgba(0,0,0,0.36),14px_0_34px_-16px_rgba(0,0,0,0.36),-14px_0_34px_-16px_rgba(0,0,0,0.36),inset_0_1px_0_rgba(255,255,255,0.18)]"
        style={{ WebkitBackdropFilter: "blur(20px) saturate(1.15)" }}
      >
        {bottomTabs && bottomTabs.length > 0 ? (
          <div
            className="grid h-full w-full items-stretch gap-px"
            style={{
              gridTemplateColumns: `repeat(${Math.max(4, bottomTabs.length)}, minmax(0, 1fr))`,
            }}
            role="tablist"
            aria-label="대시보드 메뉴"
          >
            {bottomTabs.map((tab) => {
              const showLabel = tab.showLabel !== false;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  onClick={tab.onSelectAction}
                  className={`flex min-h-0 min-w-0 flex-col items-center justify-center gap-0 px-0.5 py-0 transition ${
                    tab.active
                      ? "m-[2px] rounded-full bg-[#cccccc]/70 text-neutral-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]"
                      : "m-0 text-neutral-700"
                  }`}
                  aria-label={showLabel ? undefined : tab.label}
                  aria-selected={tab.active}
                >
                  <span className="flex h-7 w-7 items-center justify-center">
                    {tab.iconAction(tab.active)}
                  </span>
                  {showLabel ? (
                    <span className="truncate text-[10px] font-medium">
                      {tab.label}
                    </span>
                  ) : null}
                </button>
              );
            })}
            {Array.from(
              {
                length: Math.max(0, Math.max(4, bottomTabs.length) - bottomTabs.length),
              },
              (_, i) => (
                <div
                  key={`bottom-nav-slot-pad-${i}`}
                  className="min-h-0 min-w-0"
                  aria-hidden
                />
              ),
            )}
          </div>
        ) : (
          /* 심플 모드: 홈 아이콘 하나 */
          <button
            type="button"
            onClick={() => onHomeClickAction?.()}
            className="flex flex-1 items-center justify-center rounded-[calc(30px-2px)] px-4 text-neutral-700 transition hover:bg-black/[0.04] dark:hover:bg-white/10"
            aria-label="홈으로 이동"
          >
            <HomeIcon />
          </button>
        )}
      </div>
    </nav>
  );
}
