"use client";

import type { ReactNode } from "react";
import {
  DashboardBottomNav,
  type DashboardBottomNavMenuAction,
  type DashboardBottomNavTab,
} from "@/components/dashboard/dashboard-bottom-nav";
import {
  DashboardTopHeader,
  DashboardTopHeaderSpacer,
} from "@/components/dashboard/dashboard-top-header";
import { DashboardTopScrim } from "@/components/dashboard/dashboard-top-scrim";
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
      <DashboardTopScrim />
      <DashboardTopHeader
        title={title}
        showBack={showBack}
        onBack={onBack}
        backAriaLabel={backAriaLabel}
        backHint={backHint}
        onBellClick={onBellClick}
        showBell={showBellOnTitle}
      />
      <DashboardTopHeaderSpacer
        showSubline={Boolean(showBack && backHint)}
      />

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
        includeSrOnlyScreenTitle={false}
        profile={profile}
      />
    </>
  );
}
