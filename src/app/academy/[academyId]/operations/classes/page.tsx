import { Suspense } from "react";
import { AcademyClassesScreen } from "@/components/academy/classes/academy-classes-screen";

export default function AcademyClassesPage() {
  return (
    <Suspense fallback={<p className="py-12 text-center text-sm text-neutral-500">불러오는 중…</p>}>
      <AcademyClassesScreen />
    </Suspense>
  );
}
