import { Suspense } from "react";
import { AcademyHome } from "./academy-home";

export default function AcademyHomePage() {
  return (
    <Suspense fallback={<p className="py-12 text-center text-sm text-neutral-500">불러오는 중…</p>}>
      <AcademyHome />
    </Suspense>
  );
}
