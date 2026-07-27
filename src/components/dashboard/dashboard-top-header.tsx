"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { formatDashboardBellBadge } from "@/components/dashboard/dashboard-notifications-modal";
import {
  greetingDisplayNameFromProfile,
  menuProfileContactLines,
} from "@/lib/ui/dashboard-greetings";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";
import type { DashboardBottomNavMenuAction } from "@/components/dashboard/dashboard-bottom-nav";

const TOP_OUTER_PT = "pt-[max(0.85rem,env(safe-area-inset-top))]";
const TOP_OUTER_PB = "pb-1";
const INNER_ROW = "flex min-h-10 items-center justify-between gap-2";

function BellIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3a6 6 0 00-6 6v2.4L4 14v1h16v-1l-2-2.6V9a6 6 0 00-6-6z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M9 19a3 3 0 006 0"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function dashboardProfileInitial(
  displayName?: string | null,
  email?: string | null,
): string {
  const raw = displayName?.trim() || email?.trim() || "";
  if (!raw) return "?";
  const cp = raw.codePointAt(0);
  if (cp === undefined) return "?";
  return String.fromCodePoint(cp);
}

function ProfileAvatar({
  photoURL,
  initial,
  size = "sm",
}: {
  photoURL?: string | null;
  initial: string;
  size?: "sm" | "lg";
}) {
  const box = size === "lg" ? "h-14 w-14 text-lg" : "h-9 w-9 text-sm";
  if (photoURL) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- Firebase/Google photo URLs
      <img
        src={photoURL}
        alt=""
        className={`${box} rounded-full object-cover`}
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <span
      className={`flex items-center justify-center rounded-full font-semibold text-neutral-800 dark:text-neutral-100 ${box}`}
    >
      {initial}
    </span>
  );
}

function menuProfileDisplayName(
  profile: DashboardTopHeaderProps["profile"],
): string {
  const full = profile?.displayName?.trim();
  if (full) return full;
  return greetingDisplayNameFromProfile(profile);
}

export type DashboardTopHeaderProps = {
  onHomeAction?: () => void;
  onBellClickAction?: () => void;
  showBell?: boolean;
  bellBadgeCount?: number;
  /** 알림 벨 왼쪽에 배치할 액션(예: 키오스크 토글) */
  beforeBell?: ReactNode;
  affiliationLabel: string;
  menuIntro?: ReactNode;
  menuActions: DashboardBottomNavMenuAction[];
  profile: {
    displayName?: string | null;
    email?: string | null;
    photoURL?: string | null;
    phone?: string | null;
    googleLinked?: boolean;
    googleEmail?: string | null;
  } | null;
};

export function DashboardTopHeader({
  onHomeAction,
  onBellClickAction,
  showBell = true,
  bellBadgeCount = 0,
  beforeBell,
  affiliationLabel,
  menuIntro,
  menuActions,
  profile,
}: DashboardTopHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  useBodyScrollLock(menuOpen);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    if (!menuOpen) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onEsc);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onEsc);
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  const initial = dashboardProfileInitial(profile?.displayName, profile?.email);
  const hasProfilePhoto = Boolean(profile?.photoURL?.trim());

  return (
    <>
      <header
        className={`pointer-events-none fixed inset-x-0 top-0 z-30 ${TOP_OUTER_PT} ${TOP_OUTER_PB}`}
        aria-label="대시보드 상단"
      >
        <div className="pointer-events-auto mx-auto max-w-lg px-4">
          <div className={INNER_ROW}>
            {/* 왼쪽: attn. 로고 */}
            <button
              type="button"
              onClick={() => onHomeAction?.()}
              className="text-[17px] font-bold tracking-tight text-foreground transition hover:opacity-70"
              aria-label="홈으로 이동"
            >
              attn.
            </button>

            {/* 오른쪽: beforeBell + 벨 + 프로필 */}
            <div className="flex items-center gap-0.5">
              {beforeBell}
              {showBell ? (
                <button
                  type="button"
                  onClick={() => onBellClickAction?.()}
                  className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-foreground transition hover:bg-black/[0.05] dark:hover:bg-white/10"
                  aria-label={bellBadgeCount > 0 ? `알림 ${bellBadgeCount}건` : "알림"}
                >
                  <BellIcon />
                  {bellBadgeCount > 0 ? (
                    <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white shadow-sm">
                      {formatDashboardBellBadge(bellBadgeCount)}
                    </span>
                  ) : null}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                className={
                  hasProfilePhoto
                    ? "relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full shadow-sm transition hover:brightness-105"
                    : "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-neutral-300/60 bg-white/55 text-foreground shadow-sm transition hover:bg-white/90 dark:border-white/20 dark:bg-white/12 dark:hover:bg-white/18"
                }
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                aria-label="계정 메뉴"
              >
                <ProfileAvatar
                  photoURL={profile?.photoURL}
                  initial={initial}
                  size="sm"
                />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* 계정 메뉴 시트 */}
      {menuOpen ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/35 backdrop-blur-[1px]"
            onClick={closeMenu}
            aria-label="계정 메뉴 닫기"
          />
          <div
            className="relative z-[101] w-full max-w-[22rem] overflow-hidden rounded-2xl border border-neutral-300/40 bg-white/95 shadow-[0_20px_54px_-14px_rgba(0,0,0,0.25)] backdrop-blur-2xl dark:border-white/12 dark:bg-neutral-900/94"
            role="menu"
            aria-label="계정 메뉴"
          >
            <div className="px-4 pb-3 pt-3">
              <div className="flex gap-3">
                <div className="shrink-0 self-center">
                  <ProfileAvatar
                    photoURL={profile?.photoURL}
                    initial={initial}
                    size="lg"
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 text-left text-[11px] leading-tight">
                  <p className="truncate font-semibold text-foreground">
                    {menuProfileDisplayName(profile)}
                  </p>
                  {menuProfileContactLines(profile).map((line) => (
                    <p
                      key={line}
                      className="truncate text-neutral-800 dark:text-neutral-200"
                    >
                      {line}
                    </p>
                  ))}
                  <p className="truncate text-neutral-800 dark:text-neutral-200">
                    {affiliationLabel.trim() || "—"}
                  </p>
                </div>
              </div>
            </div>
            <div
              className="mx-4 border-t border-neutral-200/90 dark:border-white/10"
              role="separator"
            />
            {menuIntro != null && menuIntro !== false ? (
              <div className="px-4 py-2.5 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
                {menuIntro}
              </div>
            ) : null}
            <div className="py-1">
              {menuActions.map((a, i) => (
                <button
                  key={`${a.label}-${i}`}
                  type="button"
                  role="menuitem"
                  disabled={a.disabled}
                  className="flex w-full px-4 py-3 text-left text-sm font-medium text-foreground hover:bg-black/[0.04] disabled:opacity-45 dark:hover:bg-white/10"
                  onClick={() => {
                    if (a.disabled) return;
                    a.onSelectAction();
                    closeMenu();
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** 고정 헤더와 동일한 세로 공간을 확보해 본문이 헤더 아래에서 시작하도록 합니다. */
export function DashboardTopHeaderSpacer() {
  return (
    <div aria-hidden className={`mx-auto max-w-lg px-4 ${TOP_OUTER_PT} ${TOP_OUTER_PB}`}>
      <div className={INNER_ROW} />
    </div>
  );
}
