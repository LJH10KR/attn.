import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AcademyShell } from "@/components/academy/academy-shell";

export const metadata: Metadata = {
  title: "학원 대시보드 · attn.",
  description: "학원 운영 요약 및 알림 현황",
};

export default function AcademyLayout({ children }: { children: ReactNode }) {
  return <AcademyShell>{children}</AcademyShell>;
}
