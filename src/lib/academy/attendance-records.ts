import { FirebaseError } from "firebase/app";

/** Functions `attendance-records.ts`와 동일한 입력 제한 */
export const MAX_ABSENCE_DATES_PER_REQUEST = 31;
export const MAX_PAST_DAYS = 92;
export const MAX_FUTURE_DAYS = 31;
export const MAX_ABSENCE_NOTE_LENGTH = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export function seoulDateString(date: Date = new Date()): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function seoulDateMs(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00+09:00`).getTime();
}

/** 오늘 기준 ±일수의 서울 날짜 문자열 */
export function seoulDateOffset(days: number): string {
  return seoulDateString(new Date(seoulDateMs(seoulDateString()) + days * DAY_MS));
}

/** start~end(포함) 날짜 목록 — 순서가 뒤집혀 있거나 형식이 틀리면 빈 배열 */
export function enumerateDates(start: string, end: string): string[] {
  const s = seoulDateMs(start);
  const e = seoulDateMs(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return [];
  const out: string[] = [];
  for (let ms = s; ms <= e && out.length <= MAX_ABSENCE_DATES_PER_REQUEST; ms += DAY_MS) {
    out.push(seoulDateString(new Date(ms)));
  }
  return out;
}

/** 0=일 … 6=토 */
export function seoulWeekday(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00+09:00`).getUTCDay();
}

export function isWeekend(dateStr: string): boolean {
  const d = seoulWeekday(dateStr);
  return d === 0 || d === 6;
}

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

/** "2026-10-14" → "10.14 (수)" */
export function formatRecordDate(dateStr: string): string {
  const [, m, d] = dateStr.split("-");
  return `${m}.${d} (${WEEKDAY_LABELS[seoulWeekday(dateStr)]})`;
}

export type AttendanceNotifyResult = {
  sent?: number;
  reason?: "no_parent" | "parent_opt_out" | "no_token" | "cooldown" | "failed";
} | null;

/** 알림 결과를 기록 완료 문구 뒤에 붙일 설명으로 변환 */
export function describeNotifyResult(result: AttendanceNotifyResult): string {
  if (!result) return "";
  if (typeof result.sent === "number" && result.sent > 0) return " 학부모에게 알림을 보냈습니다.";
  switch (result.reason) {
    case "cooldown":
      return " 알림은 같은 학생에게 연달아 보낼 수 없어 생략했습니다.";
    case "no_parent":
      return " 연결된 학부모가 없어 알림은 보내지 않았습니다.";
    case "parent_opt_out":
    case "no_token":
      return " 학부모가 알림을 받지 않는 상태입니다.";
    case "failed":
      return " 알림 전송에는 실패했습니다.";
    default:
      return "";
  }
}

/** 출석·결석 버튼(`sendStudentAttendanceNotification`) 결과 문구 */
export function attendanceButtonResultMessage(
  kind: "present" | "absent",
  result: AttendanceNotifyResult,
): string {
  const label = kind === "present" ? "출석" : "결석";
  return `${label}으로 기록했습니다.${describeNotifyResult(result)}`;
}

/** 출석·결석 버튼 실패 문구 — 배포 전 구버전 Functions는 쿨다운을 오류로 반환 */
export function attendanceButtonErrorMessage(e: unknown): string {
  if (e instanceof FirebaseError && e.code === "functions/resource-exhausted") {
    return "같은 학생에게 너무 자주 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.";
  }
  return "출결을 기록하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}
