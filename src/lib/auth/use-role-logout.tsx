"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { ProcessStatusModal } from "@/components/ui/process-status-modal";
import {
  performLogout,
  type LogoutRole,
  type PerformLogoutOptions,
} from "@/lib/auth/perform-logout";

export type UseRoleLogoutOptions = {
  redirectTo: string;
  role?: LogoutRole;
  extraBadgeUserIds?: string[];
  beforeSignOut?: PerformLogoutOptions["beforeSignOut"];
  modalTitle?: string;
  modalDescription?: string;
};

export function useRoleLogout({
  redirectTo,
  role = "generic",
  extraBadgeUserIds,
  beforeSignOut,
  modalTitle = "로그아웃 중",
  modalDescription = "안전하게 로그아웃 중이에요.",
}: UseRoleLogoutOptions) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const logout = useCallback(async () => {
    setBusy(true);
    try {
      await performLogout({ role, extraBadgeUserIds, beforeSignOut });
      router.replace(redirectTo);
    } finally {
      setBusy(false);
    }
  }, [beforeSignOut, extraBadgeUserIds, redirectTo, role, router]);

  const logoutModal = useMemo(
    () => (
      <ProcessStatusModal
        open={busy}
        title={modalTitle}
        description={modalDescription}
        animated
      />
    ),
    [busy, modalDescription, modalTitle],
  );

  return { logout, logoutBusy: busy, logoutModal };
}
