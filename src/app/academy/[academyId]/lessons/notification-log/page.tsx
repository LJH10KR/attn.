"use client";

import { AcademyAttendanceLogPanel } from "@/components/academy/academy-attendance-log-panel";
import { useAcademyShell } from "@/components/academy/academy-shell";

export default function AcademyNotificationLogPage() {
  const { academyId, permissions } = useAcademyShell();
  return (
    <AcademyAttendanceLogPanel
      academyId={academyId}
      storageScopeKey={`academy_${academyId}`}
      // 3-B 다시 보내기 — 원장·출결 권한(서버도 같은 조건)
      canResend={permissions.can("lessons.attendance")}
    />
  );
}
