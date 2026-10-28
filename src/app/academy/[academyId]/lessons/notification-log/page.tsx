"use client";

import { AcademyAttendanceLogPanel } from "@/components/academy/academy-attendance-log-panel";
import { useAcademyShell } from "@/components/academy/academy-shell";

export default function AcademyNotificationLogPage() {
  const { academyId } = useAcademyShell();
  return <AcademyAttendanceLogPanel academyId={academyId} storageScopeKey={`academy_${academyId}`} />;
}
