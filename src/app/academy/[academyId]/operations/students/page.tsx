import { Suspense } from "react";
import { AcademyStudentsScreen } from "@/components/academy/students/academy-students-screen";

export default function AcademyStudentsPage() {
  return (
    <Suspense fallback={<p className="py-12 text-center text-sm text-neutral-500">불러오는 중…</p>}>
      <AcademyStudentsScreen />
    </Suspense>
  );
}
