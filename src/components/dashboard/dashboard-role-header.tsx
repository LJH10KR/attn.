"use client";

import type { ReactNode } from "react";
import {
  DashboardBottomNav,
  type DashboardBottomNavMenuAction,
  type DashboardBottomNavTab,
} from "@/components/dashboard/dashboard-bottom-nav";
import type { AuthProfilePayload } from "@/lib/firebase/use-auth-profile";

type DashboardRoleHeaderProps = {
  title: string;
  affiliationLabel: string;
  profile: AuthProfilePayload | null;
  onLogout: () => void;
  logoutBusy?: boolean;
  showBack?: boolean;
  onBack?: () => void;
  backAriaLabel?: string;
  backHint?: string;
  menuIntro?: ReactNode;
  onHome?: () => void;
  onBellClick?: () => void;
  showBellOnTitle?: boolean;
  showBellInBottomBar?: boolean;
  bottomTabs?: DashboardBottomNavTab[];
  includeSettingsAction?: boolean;
  onSettings?: () => void;
  settingsLabel?: string;
  logoutLabel?: string;
  extraMenuActions?: DashboardBottomNavMenuAction[];
};

export function DashboardRoleHeader({
  title,
  affiliationLabel,
  profile,
  onLogout,
  logoutBusy = false,
  showBack = false,
  onBack,
  backAriaLabel,
  backHint,
  menuIntro,
  onHome,
  onBellClick,
  showBellOnTitle = false,
  showBellInBottomBar = true,
  bottomTabs,
  includeSettingsAction = false,
  onSettings,
  settingsLabel = "사용자 설정",
  logoutLabel = "로그아웃",
  extraMenuActions = [],
}: DashboardRoleHeaderProps) {
  const menuActions: DashboardBottomNavMenuAction[] = [];
  const TitleBellButton = showBellOnTitle ? (
    <button
      type="button"
      onClick={() => onBellClick?.()}
      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/45 text-neutral-700 shadow-sm backdrop-blur-md transition hover:bg-white/75"
      aria-label="알림"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M12 3a6 6 0 00-6 6v2.4L4 14v1h16v-1l-2-2.6V9a6 6 0 00-6-6z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M9 19a3 3 0 006 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </button>
  ) : null;

  if (includeSettingsAction && onSettings) {
    menuActions.push({ label: settingsLabel, onSelect: onSettings });
  }
  if (extraMenuActions.length > 0) {
    menuActions.push(...extraMenuActions);
  }
  menuActions.push({
    label: logoutBusy ? "처리 중…" : logoutLabel,
    onSelect: onLogout,
    disabled: logoutBusy,
  });

  return (
    <>
      <section className="mx-auto max-w-lg px-4 pb-1 pt-[max(0.85rem,env(safe-area-inset-top))]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {showBack ? (
              <button
                type="button"
                onClick={onBack}
                aria-label={backAriaLabel ?? "뒤로 가기"}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-transparent text-foreground transition hover:bg-black/[0.05]"
              >
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M15 6l-6 6 6 6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : null}
            <h1 className="truncate text-[23px] font-bold tracking-tight text-foreground">{title}</h1>
          </div>
          {TitleBellButton}
        </div>
        {showBack && backHint ? (
          <p className="mt-1 pl-11 text-xs text-neutral-500">{backHint}</p>
        ) : null}
      </section>

      <DashboardBottomNav
        title={title}
        affiliationLabel={affiliationLabel}
        showBack={false}
        onHomeClick={onHome}
        onBellClick={onBellClick}
        showBellInBottomBar={showBellInBottomBar}
        bottomTabs={bottomTabs}
        menuIntro={menuIntro}
        menuActions={menuActions}
        profile={profile}
      />
    </>
  );
}
