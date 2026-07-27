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
  bellBadgeCount?: number;
  beforeBell?: ReactNode;
  bottomTabs?: DashboardBottomNavTab[];
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
    menuActions.push({ label: settingsLabel, onSelectAction: onSettingsAction });
  }
  if (extraMenuActions.length > 0) {
    menuActions.push(...extraMenuActions);
  }
  if (isAdmin) {
    menuActions.push({
      label: "관리자 페이지로",
      onSelectAction: () => router.push("/admin"),
    });
  }
  menuActions.push({
    label: logoutBusy ? "처리 중…" : logoutLabel,
    onSelectAction: onLogoutAction,
    disabled: logoutBusy,
  });

  return (
    <>
      <DashboardTopScrim />
      <DashboardTopHeader
        onHomeAction={onHomeAction}
        onBellClickAction={onBellClickAction}
        bellBadgeCount={bellBadgeCount}
        beforeBell={beforeBell}
        affiliationLabel={affiliationLabel}
        menuIntro={menuIntro}
        menuActions={menuActions}
        profile={profile}
      />
      <DashboardTopHeaderSpacer />

      {hideBottomNav ? null : (
        <DashboardBottomNav
          title={title}
          showBack={showBack}
          onBackAction={onBackAction}
          backAriaLabel={backAriaLabel}
          backHint={backHint}
          onHomeClickAction={onHomeAction}
          bottomTabs={bottomTabs}
          includeSrOnlyScreenTitle={false}
        />
      )}
    </>
  );
}
