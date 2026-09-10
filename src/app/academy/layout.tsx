"use client";

import { KioskExitPinGate } from "@/components/academy/kiosk-exit-pin-gate";
import { KioskHistoryGuard } from "@/components/academy/kiosk-history-guard";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { isKioskModeActive } from "@/lib/academy/kiosk-student-rows";

function AcademyLayoutInner({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const academyId = searchParams.get("id")?.trim() ?? "";
  const isSettings = pathname === "/academy/settings";

  const historyGuard = academyId ? <KioskHistoryGuard academyId={academyId} /> : null;

  if (!isSettings || !academyId || !isKioskModeActive(academyId)) {
    return (
      <>
        {historyGuard}
        {children}
      </>
    );
  }

  const cancelHref = `/academy?id=${encodeURIComponent(academyId)}`;

  return (
    <>
      {historyGuard}
      <KioskExitPinGate academyId={academyId} cancelHref={cancelHref}>
        {children}
      </KioskExitPinGate>
    </>
  );
}

export default function AcademyLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={children}>
      <AcademyLayoutInner>{children}</AcademyLayoutInner>
    </Suspense>
  );
}
