import { Suspense } from "react";
import { AcademyAttendanceScreen } from "@/components/academy/attendance/academy-attendance-screen";

export default function AcademyAttendancePage() {
  return (
    <Suspense fallback={<p className="py-12 text-center text-sm text-neutral-500">불러오는 중…</p>}>
      <AcademyAttendanceScreen />
    </Suspense>
  );
}
