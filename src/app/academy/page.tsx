import type { Metadata } from "next";
import { Suspense } from "react";
import { AcademyDashboard } from "./academy-dashboard";

export const metadata: Metadata = {
  title: "학원 대시보드 · attn.",
  description: "학원 운영 요약 및 알림 현황",
};

function AcademyFallback() {
  return (
    <div className="min-h-[100dvh] bg-background flex items-center justify-center">
      <p className="text-sm text-neutral-500">불러오는 중…</p>
    </div>
  );
}

export default function AcademyPage() {
  return (
    <Suspense fallback={<AcademyFallback />}>
      <AcademyDashboard />
    </Suspense>
  );
}