"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { greetingDisplayNameFromProfile } from "@/lib/ui/dashboard-greetings";

const glassCard = "glass-card";

export type DashboardHeaderMenuAction = {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
};

export type DashboardAppHeaderProps = {
  /** 접근성용 — 화면에는 보이지 않고 스크린 리더만 읽습니다 */
  title: string;
  /** 프로필 메뉴에 표시할 소속 학원(오너는 운영 학원 요약 등) */
  affiliationLabel: string;
  /** 구분선 아래·메뉴 항목 위 보조 안내(선택) */
  menuIntro?: ReactNode;
  showBack: boolean;
  onBack?: () => void;
  backAriaLabel?: string;
  /** 뒤로 버튼 옆에 표시 (오너가 학원 대시보드에서 돌아갈 때 등) */
  backHint?: string;
  onBellClick?: () => void;
  menuActions: DashboardHeaderMenuAction[];
  profile: {
    displayName?: string | null;
    email?: string | null;
    photoURL?: string | null;
  } | null;
  className?: string;
};

function BellIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3a6 6 0 00-6 6v2.4L4 14v1h16v-1l-2-2.6V9a6 6 0 00-6-6z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9 19a3 3 0 006 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function BackChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
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
      className={`flex items-center justify-center rounded-full bg-neutral-200/90 font-semibold text-neutral-800 shadow-inner dark:bg-white/15 dark:text-neutral-100 ${box}`}
    >
      {initial}
    </span>
  );
}

function menuProfileDisplayName(
  profile: DashboardAppHeaderProps["profile"],
): string {
  const full = profile?.displayName?.trim();
  if (full) return full;
  return greetingDisplayNameFromProfile(profile);
}

export function DashboardAppHeader({
  title,
  affiliationLabel,
  menuIntro,
  showBack,
  onBack,
  backAriaLabel = "뒤로 가기",
  backHint,
  onBellClick,
  menuActions,
  profile,
  className = "",
}: DashboardAppHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const el = menuWrapRef.current;
      if (el && !el.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const initial = dashboardProfileInitial(profile?.displayName, profile?.email);

  return (
    <header
      className={`sticky top-0 z-30 mx-auto max-w-lg px-4 pb-3 pt-[max(0.65rem,env(safe-area-inset-top))] ${className}`}
    >
      <h1 className="sr-only">{title}</h1>
      {/* 글래스 테두리는 로고·알림·프로필 행에만 적용 */}
      <div className={`${glassCard} px-3 py-2.5`} style={{ WebkitBackdropFilter: "blur(20px)" }}>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[17px] font-bold tracking-tight text-foreground">attn.</p>
          <div className="flex flex-1 justify-end">
            <div className="relative flex items-center gap-1.5" ref={menuWrapRef}>
              <button
                type="button"
                onClick={() => onBellClick?.()}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-neutral-300/50 bg-white/45 text-neutral-700 shadow-sm backdrop-blur-md transition hover:bg-white/75 dark:border-white/12 dark:bg-white/10 dark:text-neutral-200 dark:hover:bg-white/15"
                aria-label="알림"
              >
                <BellIcon className="text-current" />
              </button>
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/45 shadow-sm backdrop-blur-md transition hover:bg-white/75 dark:bg-white/10 dark:hover:bg-white/15"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                aria-label="계정 메뉴"
              >
                <ProfileAvatar photoURL={profile?.photoURL} initial={initial} />
              </button>
              {menuOpen ? (
                <div
                  className="absolute right-0 top-[calc(100%+10px)] z-[100] max-w-[min(22rem,calc(100vw-2rem))] min-w-[16rem] overflow-hidden rounded-2xl border border-neutral-300/40 bg-white/90 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.2)] backdrop-blur-2xl dark:border-white/12 dark:bg-neutral-900/92"
                  role="menu"
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
                        <p className="truncate text-neutral-800 dark:text-neutral-200">
                          {profile?.email?.trim() || "—"}
                        </p>
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
                          a.onSelect();
                          closeMenu();
                        }}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {showBack ? (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="flex h-10 w-11 shrink-0 items-center justify-center rounded-2xl border border-neutral-300/55 bg-white/55 text-foreground shadow-[0_4px_14px_-4px_rgba(0,0,0,0.12)] backdrop-blur-md transition hover:bg-white/85 active:scale-[0.98] dark:border-white/12 dark:bg-white/10 dark:hover:bg-white/15"
            aria-label={backAriaLabel}
          >
            <BackChevronIcon />
          </button>
          {backHint ? (
            <span className="min-w-0 text-sm font-medium leading-snug text-foreground">{backHint}</span>
          ) : null}
        </div>
      ) : null}

    </header>
  );
}
