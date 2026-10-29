import { Timestamp } from "firebase/firestore";

export function nowKST(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date());
  return {
    year: Number(parts.find((p) => p.type === "year")?.value ?? new Date().getFullYear()),
    month: Number(parts.find((p) => p.type === "month")?.value ?? new Date().getMonth() + 1),
  };
}

export function kstMonthBounds(year: number, month: number): { start: Timestamp; end: Timestamp } {
  const KST = 9 * 60 * 60 * 1000;
  return {
    start: Timestamp.fromMillis(Date.UTC(year, month - 1, 1) - KST),
    end: Timestamp.fromMillis(Date.UTC(year, month, 1) - KST),
  };
}
