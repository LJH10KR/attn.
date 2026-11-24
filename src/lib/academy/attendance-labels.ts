import { ABSENCE_REASON_LABELS, formatSeoulHHmm, isAbsenceReason } from "@/lib/academy/attendance-rules";
import type { DayArrival } from "@/lib/academy/day-roster";

/** "질병"·"학원 사정"·"기타"(모르는 값이면 null) */
export function reasonLabel(reason: string | null | undefined): string | null {
  return isAbsenceReason(reason) ? ABSENCE_REASON_LABELS[reason] : null;
}

/**
 * 등원 기록 한 줄 — "등원 14:52" / "등원 14:30(입력)" / "등원 · 시각 없음"(지난 날짜 정정, ★2) /
 * "미등원(질병)" / "기록 없음". undefined = 읽는 중.
 */
export function arrivalSummary(a: DayArrival | null | undefined): string {
  if (a === undefined) return "확인 중";
  if (!a) return "기록 없음";
  if (a.status === "absent") {
    const r = reasonLabel(a.reason);
    return r ? `미등원(${r})` : "미등원";
  }
  if (a.arrivedAtMs === null) return "등원 · 시각 없음";
  return `등원 ${formatSeoulHHmm(new Date(a.arrivedAtMs))}${a.arrivedAtManual ? "(입력)" : ""}`;
}

/** time input 값("HH:mm") — 시각이 없으면 "" */
export function arrivalTimeInput(a: DayArrival | null | undefined): string {
  return a && a.status === "present" && a.arrivedAtMs !== null ? formatSeoulHHmm(new Date(a.arrivedAtMs)) : "";
}

/** 3-B 하원 한 줄 — "하원 18:05" / "하원 18:05(입력)" / "하원 · 시각 없음" / "하원 기록 없음"(★14) */
export function departureSummary(a: DayArrival | null | undefined): string {
  if (!a || a.status !== "present" || !a.departed) return "하원 기록 없음";
  if (a.leftAtMs === null) return "하원 · 시각 없음";
  return `하원 ${formatSeoulHHmm(new Date(a.leftAtMs))}${a.leftAtManual ? "(입력)" : ""}`;
}

/** 하원 time input 값 — 시각이 없으면 "" */
export function leftTimeInput(a: DayArrival | null | undefined): string {
  return a && a.departed && a.leftAtMs !== null ? formatSeoulHHmm(new Date(a.leftAtMs)) : "";
}

/** 3-B 반 출결 이름 — "출석"·"지각 10분"·"결석(질병)" */
export function classRecordLabel(r: { status: "present" | "late" | "absent"; lateMinutes?: number | null; reason?: string | null }): string {
  if (r.status === "late") return typeof r.lateMinutes === "number" ? `지각 ${r.lateMinutes}분` : "지각";
  if (r.status === "absent") {
    const reason = reasonLabel(r.reason);
    return reason && r.reason !== "general" ? `결석(${reason})` : "결석";
  }
  return "출석";
}
