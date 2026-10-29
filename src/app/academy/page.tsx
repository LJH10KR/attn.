import type { Metadata } from "next";
import { AcademyEntry } from "./academy-entry";

export const metadata: Metadata = {
  title: "학원 대시보드 · attn.",
  description: "학원 운영 요약 및 알림 현황",
};

/** 학원 ID 없이 들어온 경우 — 갈 학원을 정해 `/academy/[academyId]`로 보낸다(예전 `?id=` 주소는 middleware가 먼저 옮김) */
export default function AcademyPage() {
  return <AcademyEntry />;
}
