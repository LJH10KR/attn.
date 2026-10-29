"use client";

import { AcademyParentPanel } from "@/components/academy/academy-parent-panel";
import { useAcademyShell } from "@/components/academy/academy-shell";

export default function AcademyParentsPage() {
  const { academyId } = useAcademyShell();
  return <AcademyParentPanel academyId={academyId} />;
}
