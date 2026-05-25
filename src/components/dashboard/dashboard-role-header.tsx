"use client";

import { onAuthStateChanged } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
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
  onLogoutAction: () => void;
  logoutBusy?: boolean;
  showBack?: boolean;
  onBackAction?: () => void;
  backAriaLabel?: string;
  backHint?: string;
  menuIntro?: ReactNode;
  onHomeAction?: () => void;
  onBellClickAction?: () => void;
  showBellOnTitle?: boolean;
  showBellInBottomBar?: boolean;
  bellBadgeCount?: number;
  beforeBell?: ReactNode;
  bottomTabs?: DashboardBottomNavTab[];
  /** true이면 하단 탭·프로필 바 전체를 숨깁니다(키오스크 등) */
  hideBottomNav?: boolean;
  includeSettingsAction?: boolean;
  onSettingsAction?: () => void;
  settingsLabel?: string;
  logoutLabel?: string;
  extraMenuActions?: DashboardBottomNavMenuAction[];
};

export function DashboardRoleHeader({
  title,
  affiliationLabel,
  profile,
  onLogoutAction,
  logoutBusy = false,
  showBack = false,
  onBackAction,
  backAriaLabel,
  backHint,
  menuIntro,
  onHomeAction,
  onBellClickAction,
  showBellOnTitle = false,
  showBellInBottomBar = true,
  bellBadgeCount = 0,
  beforeBell,
  bottomTabs,
  hideBottomNav = false,
  includeSettingsAction = false,
  onSettingsAction,
  settingsLabel = "사용자 설정",
  logoutLabel = "로그아웃",
  extraMenuActions = [],
}: DashboardRoleHeaderProps) {
  const menuActions: DashboardBottomNavMenuAction[] = [];
  const router = useRouter();
  const configured = isFirebaseConfigured();
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!configured) return;
    const auth = getFirebaseAuth();
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        setIsAdmin(false);
        return;
      }
      try {
        const tokenResult = await u.getIdTokenResult();
        setIsAdmin(tokenResult.claims.admin === true);
      } catch {
        setIsAdmin(false);
      }
    });
    return () => unsub();
  }, [configured]);

  if (includeSettingsAction && onSettingsAction) {
    menuActions.push({ label: settingsLabel, onSelect: onSettingsAction });
  }
  if (extraMenuActions.length > 0) {
    menuActions.push(...extraMenuActions);
  }
  if (isAdmin) {
    menuActions.push({
      label: "관리자 페이지로",
      onSelect: () => router.push("/admin"),
    });
  }
  menuActions.push({
    label: logoutBusy ? "처리 중…" : logoutLabel,
    onSelect: onLogoutAction,
    disabled: logoutBusy,
  });

  return (
    <>
      <DashboardTopScrim />
      <DashboardTopHeader
        title={title}
        showBack={showBack}
        onBackAction={onBackAction}
        backAriaLabel={backAriaLabel}
        backHint={backHint}
        onBellClickAction={onBellClickAction}
        showBell={showBellOnTitle}
        bellBadgeCount={bellBadgeCount}
        beforeBell={beforeBell}
      />
      <DashboardTopHeaderSpacer
        showSubline={Boolean(showBack && backHint)}
      />

      {hideBottomNav ? null : (
        <DashboardBottomNav
          title={title}
          affiliationLabel={affiliationLabel}
          showBack={false}
          onHomeClick={onHomeAction}
          onBellClick={onBellClickAction}
          showBellInBottomBar={showBellInBottomBar}
          bellBadgeCount={bellBadgeCount}
          bottomTabs={bottomTabs}
          menuIntro={menuIntro}
          menuActions={menuActions}
          includeSrOnlyScreenTitle={false}
          profile={profile}
        />
      )}
    </>
  );
}
