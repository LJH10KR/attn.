import type { Metadata } from "next";
import { OwnerDashboard } from "./owner-dashboard";

export const metadata: Metadata = {
  title: "오너 대시보드 — attn.",
  description: "학원 등록 및 관리",
};

export default function OwnerPage() {
  return <OwnerDashboard />;
}
