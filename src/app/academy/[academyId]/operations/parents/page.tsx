import { Suspense } from "react";
import { AcademyParentsScreen } from "@/components/academy/parents/academy-parents-screen";

export default function AcademyParentsPage() {
  return (
    <Suspense fallback={<p className="py-12 text-center text-sm text-neutral-500">불러오는 중…</p>}>
      <AcademyParentsScreen />
    </Suspense>
  );
}
