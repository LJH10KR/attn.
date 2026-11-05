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
  reason?: "no_parent" | "parent_opt_out" | "no_token" | "cooldown" | "daily_limit" | "unchanged" | "failed";
} | null;

/** 알림 결과를 기록 완료 문구 뒤에 붙일 설명으로 변환 */
export function describeNotifyResult(result: AttendanceNotifyResult): string {
  if (!result) return "";
  if (typeof result.sent === "number" && result.sent > 0) return " 학부모에게 알림을 보냈습니다.";
  switch (result.reason) {
    case "cooldown":
      return " 알림은 같은 학생에게 연달아 보낼 수 없어 생략했습니다.";
    case "daily_limit":
      return " 오늘 이 학생에게 보낸 알림이 너무 많아 알림은 생략했습니다.";
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

/** `recordStudentArrival`·`recordClassAttendance` 응답 */
export type AttendanceActionResult = {
  ok?: boolean;
  status?: "present" | "absent";
  changed?: boolean;
  notification?: AttendanceNotifyResult;
};

/**
 * 등원·반 출결 버튼 결과 문구.
 * @param label "등원"·"미등원"·"A반 출석" 등 기록한 상태 이름
 */
export function attendanceActionMessage(label: string, result: AttendanceActionResult): string {
  if (result.changed === false) return `이미 ${label}${withEuro(label)} 기록되어 있습니다.`;
  return `${label}${withEuro(label)} 기록했습니다.${describeNotifyResult(result.notification ?? null)}`;
}

/** 받침에 따라 "으로"/"로" — 받침 없거나 ㄹ 받침이면 "로" */
function withEuro(word: string): string {
  const last = word.charCodeAt(word.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return "(으)로";
  const jong = (last - 0xac00) % 28;
  return jong === 0 || jong === 8 ? "로" : "으로";
}

/** `cancelClassAttendance`·`cancelStudentArrival` 응답(2-J) */
export type AttendanceCancelResult = {
  ok?: boolean;
  changed?: boolean;
  cancelled?: "present" | "absent" | null;
  notification?: AttendanceNotifyResult;
};

/**
 * 출결 취소 결과 문구(2-J).
 * @param label "A반 출석"·"등원"·"미등원" 등 취소한 기록 이름
 */
export function attendanceCancelMessage(label: string, result: AttendanceCancelResult): string {
  if (result.changed === false) return "취소할 기록이 없습니다. 이미 취소되었을 수 있습니다.";
  return `${label} 기록을 취소했습니다.${describeNotifyResult(result.notification ?? null)}`;
}

/** 등원·반 출결 버튼 실패 문구 — 서버의 조건·권한 문구를 그대로 보여 준다 */
export function attendanceActionErrorMessage(
  e: unknown,
  fallback = "출결을 기록하지 못했습니다. 잠시 후 다시 시도해 주세요.",
): string {
  if (e instanceof FirebaseError) {
    if (e.code === "functions/resource-exhausted") {
      return "같은 학생에게 너무 자주 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.";
    }
    if (
      (e.code === "functions/failed-precondition" ||
        e.code === "functions/permission-denied" ||
        e.code === "functions/not-found" ||
        e.code === "functions/invalid-argument") &&
      e.message
    ) {
      return e.message;
    }
  }
  return fallback;
}
