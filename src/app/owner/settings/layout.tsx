import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "사용자 설정 — attn.",
  description: "오너 계정 및 로그인 설정",
};

export default function OwnerSettingsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
