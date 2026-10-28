"use client";

import { useAcademyShell } from "@/components/academy/academy-shell";
import { AcademyStudentPanel } from "@/components/academy/academy-student-panel";

export default function AcademyStudentsPage() {
  const { academyId } = useAcademyShell();
  return <AcademyStudentPanel academyId={academyId} />;
}
