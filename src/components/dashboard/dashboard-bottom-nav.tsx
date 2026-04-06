"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { greetingDisplayNameFromProfile } from "@/lib/ui/dashboard-greetings";

/** 계정 메뉴(프로필 버튼) 항목 */
export type DashboardBottomNavMenuAction = {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
};

/** 하단 캡슐 바의 탭 한 칸 */
export type DashboardBottomNavTab = {
  id: string;
  /** 접근성(aria-label 등)용 — `showLabel: false`일 때도 유지하는 것을 권장 */
  label: string;
  icon: (active: boolean) => ReactNode;
  active: boolean;
  onSelect: () => void;
  /** false이면 아래 한 줄 라벨을 렌더하지 않음(로고만 등) */
  showLabel?: boolean;
};

export type DashboardBottomNavProps = {
  /** 스크린 리더용 현재 화면 제목(시각적으로 숨김) */
  title: string;
  /** 계정 메뉴에 표시되는 소속·학원 라벨 */
  affiliationLabel: string;
  /** 계정 메뉴 상단 안내(선택) */
  menuIntro?: ReactNode;
  showBack: boolean;
  onBack?: () => void;
  backAriaLabel?: string;
  /** 뒤로 버튼 옆 보조 문구 */
  backHint?: string;
  /** 탭이 없을 때 왼쪽 "attn." 텍스트 버튼 동작 */
  onHomeClick?: () => void;
  onBellClick?: () => void;
  /** 탭 미사용 모드에서 캡슐 안에 알림 벨 표시 */
  showBellInBottomBar?: boolean;
  bottomTabs?: DashboardBottomNavTab[];
  menuActions: DashboardBottomNavMenuAction[];
  /**
   * false이면 `title`을 스크린 리더 전용 문단으로 반복하지 않습니다.
   * 상단 헤더에 같은 제목이 있을 때 중복 안내를 줄이기 위해 사용합니다.
   */
  includeSrOnlyScreenTitle?: boolean;
  profile: {
    displayName?: string | null;
    email?: string | null;
    photoURL?: string | null;
  } | null;
  className?: string;
};

function BellIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
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
  profile: DashboardBottomNavProps["profile"],
): string {
  const full = profile?.displayName?.trim();
  if (full) return full;
  return greetingDisplayNameFromProfile(profile);
}

/**
 * 대시보드 하단 고정 바: 탭(또는 홈·알림) + 프로필·계정 시트.
 * (Material 등에서 말하는 bottom navigation / tab bar 역할)
 */
export function DashboardBottomNav({
  title,
  affiliationLabel,
  menuIntro,
  showBack,
  onBack,
  backAriaLabel = "뒤로 가기",
  backHint,
  onHomeClick,
  onBellClick,
  showBellInBottomBar = true,
  bottomTabs,
  menuActions,
  includeSrOnlyScreenTitle = true,
  profile,
  className = "",
}: DashboardBottomNavProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    if (!menuOpen) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
      }
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
    <nav
      className={`fixed inset-x-0 bottom-[25px] z-30 mx-auto max-w-lg px-4 ${className}`}
      aria-label="대시보드 하단 메뉴"
    >
      {includeSrOnlyScreenTitle ? <p className="sr-only">{title}</p> : null}
      <div className="flex items-center gap-2">
        {/* 메인 하단 캡슐 */}
        <div
          className="flex h-[60px] min-w-0 flex-1 items-stretch overflow-hidden rounded-full bg-white/38 p-[2px] shadow-[0_12px_30px_-14px_rgba(0,0,0,0.10),0_-12px_30px_-14px_rgba(0,0,0,0.10),12px_0_30px_-14px_rgba(0,0,0,0.10),-12px_0_30px_-14px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.78)] dark:bg-white/10 dark:shadow-[0_14px_34px_-16px_rgba(0,0,0,0.36),0_-14px_34px_-16px_rgba(0,0,0,0.36),14px_0_34px_-16px_rgba(0,0,0,0.36),-14px_0_34px_-16px_rgba(0,0,0,0.36),inset_0_1px_0_rgba(255,255,255,0.18)]"
          style={{ WebkitBackdropFilter: "blur(20px) saturate(1.15)" }}
        >
          {bottomTabs && bottomTabs.length > 0 ? (
            <div
              className="grid h-full w-full grid-cols-4 items-stretch gap-px"
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
                    onClick={tab.onSelect}
                    className={`flex min-h-0 min-w-0 flex-col items-center justify-center gap-0 px-0.5 py-0 transition ${
                      tab.active
                        ? "m-[2px] rounded-full bg-[#cccccc]/70 text-neutral-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]"
                        : "m-0 text-neutral-700"
                    }`}
                    aria-label={showLabel ? undefined : tab.label}
                    aria-selected={tab.active}
                  >
                    <span
                      className={`flex items-center justify-center ${tab.id === "home" ? "h-7 w-[5rem] min-w-[5rem] shrink-0" : "h-7 w-7"}`}
                    >
                      {tab.icon(tab.active)}
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
                { length: Math.max(0, 4 - bottomTabs.length) },
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
            <>
              <button
                type="button"
                onClick={() => onHomeClick?.()}
                className="rounded-2xl px-2 py-1 text-[17px] font-bold tracking-tight text-foreground transition hover:bg-black/[0.04] dark:hover:bg-white/10"
                aria-label="홈으로 이동"
              >
                attn.
              </button>
              {showBellInBottomBar ? (
                <button
                  type="button"
                  onClick={() => onBellClick?.()}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-neutral-300/50 bg-white/45 text-neutral-700 shadow-sm backdrop-blur-md transition hover:bg-white/75 dark:border-white/12 dark:bg-white/10 dark:text-neutral-200 dark:hover:bg-white/15"
                  aria-label="알림"
                >
                  <BellIcon className="text-current" />
                </button>
              ) : null}
            </>
          )}
        </div>

        {/* 우측 단일 원형 프로필 버튼 */}
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          className={
            hasProfilePhoto
              ? "relative flex h-[60px] w-[60px] shrink-0 items-center justify-center overflow-hidden rounded-full shadow-[0_10px_28px_-10px_rgba(0,0,0,0.10),0_-10px_28px_-10px_rgba(0,0,0,0.10),10px_0_28px_-10px_rgba(0,0,0,0.10),-10px_0_28px_-10px_rgba(0,0,0,0.10)] transition hover:brightness-105 dark:shadow-[0_12px_28px_-10px_rgba(0,0,0,0.32),0_-12px_28px_-10px_rgba(0,0,0,0.32),12px_0_28px_-10px_rgba(0,0,0,0.32),-12px_0_28px_-10px_rgba(0,0,0,0.32)]"
              : "relative flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-full border border-white/65 bg-white/38 p-0.5 shadow-[0_10px_28px_-10px_rgba(0,0,0,0.10),0_-10px_28px_-10px_rgba(0,0,0,0.10),10px_0_28px_-10px_rgba(0,0,0,0.10),-10px_0_28px_-10px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.8)] transition hover:bg-white/52 dark:border-white/20 dark:bg-white/12 dark:shadow-[0_12px_30px_-12px_rgba(0,0,0,0.36),0_-12px_30px_-12px_rgba(0,0,0,0.36),12px_0_30px_-12px_rgba(0,0,0,0.36),-12px_0_30px_-12px_rgba(0,0,0,0.36),inset_0_1px_0_rgba(255,255,255,0.2)] dark:hover:bg-white/18"
          }
          style={
            hasProfilePhoto
              ? undefined
              : { WebkitBackdropFilter: "blur(18px) saturate(1.15)" }
          }
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label="계정 메뉴"
        >
          {!hasProfilePhoto ? (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-[2px] rounded-full bg-gradient-to-br from-white/70 via-white/20 to-transparent dark:from-white/20 dark:via-white/5 dark:to-transparent"
            />
          ) : null}
          <ProfileAvatar
            photoURL={profile?.photoURL}
            initial={initial}
            size="lg"
          />
        </button>
      </div>

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
        </div>
      ) : null}

      {showBack ? (
        <div className="mb-2 flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
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
    </nav>
  );
}
