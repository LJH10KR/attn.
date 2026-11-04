/**
 * 2-I 등원·반 출결 판단 — 조건 코드, 상태 전환, 알림 문구, 서울 시각.
 * `functions/src/lib/attendance-rules.ts`와 같은 내용(student-profile·permissions처럼 두 곳을 함께 맞춘다).
 * 서버가 실제로 막고, 화면은 같은 코드로 버튼을 옅게 하고 이유를 붙인다.
 */

export type AttendanceStatus = "present" | "absent";

export type ScheduleSlotLike = { weekday: number; start: string; end: string };

/** 반 출결을 막는 이유(검사 순서대로) */
export const CLASS_ATTENDANCE_BLOCKS = [
  "inactive_student",
  "not_member",
  "class_ended",
  "no_lesson_today",
  "not_arrived",
  "billed_absent",
  "absent_today",
] as const;
export type ClassAttendanceBlock = (typeof CLASS_ATTENDANCE_BLOCKS)[number];

/** 화면 버튼 옆 짧은 이유 */
export const CLASS_ATTENDANCE_BLOCK_LABELS: Record<ClassAttendanceBlock, string> = {
  inactive_student: "재원 아님",
  not_member: "반 원생 아님",
  class_ended: "종강",
  no_lesson_today: "오늘 수업 없음",
  not_arrived: "등원 전",
  billed_absent: "차감 반영일",
  absent_today: "미등원",
};

/** 서버 오류 문구 */
export const CLASS_ATTENDANCE_BLOCK_MESSAGES: Record<ClassAttendanceBlock, string> = {
  inactive_student: "재원 중인 원생만 출결을 기록할 수 있습니다.",
  not_member: "이 반 원생이 아닙니다.",
  class_ended: "종강한 반에는 출결을 기록할 수 없습니다.",
  no_lesson_today: "오늘은 이 반 수업이 없습니다.",
  not_arrived: "아직 등원 처리되지 않았습니다. 등원 처리 후 기록해 주세요.",
  billed_absent: "청구서 결석 차감에 반영된 날입니다. 청구서에서 차감을 삭제한 뒤 등원 처리해 주세요.",
  absent_today: "오늘 미등원으로 기록된 학생입니다. 등원 처리 후 기록해 주세요.",
};

/** 그날 등원 기록 요약 — 문서가 없으면 null */
export type ArrivalSnapshot = { status: AttendanceStatus; billed: boolean } | null;

export function classAttendanceBlock(params: {
  studentActive: boolean;
  isMember: boolean;
  classEnded: boolean;
  hasLessonToday: boolean;
  arrival: ArrivalSnapshot;
}): ClassAttendanceBlock | null {
  if (!params.studentActive) return "inactive_student";
  if (!params.isMember) return "not_member";
  if (params.classEnded) return "class_ended";
  if (!params.hasLessonToday) return "no_lesson_today";
  if (!params.arrival) return "not_arrived";
  if (params.arrival.status === "absent") return params.arrival.billed ? "billed_absent" : "absent_today";
  return null;
}

/**
 * 등원 기록 전환 판단(버튼).
 * - unchanged: 같은 상태 — 기록·알림 그대로
 * - billed: 차감 잠금 날짜 — 바꾸지 않음
 * - has_class_records: 등원 → 미등원인데 그날 반 출결이 있음
 */
export type ArrivalTransition = "ok" | "unchanged" | "billed" | "has_class_records";

export function arrivalTransition(
  prev: ArrivalSnapshot,
  next: AttendanceStatus,
  classRecordCount: number,
): ArrivalTransition {
  if (prev && prev.status === next) return "unchanged";
  if (prev?.billed) return "billed";
  if (next === "absent" && classRecordCount > 0) return "has_class_records";
  return "ok";
}

export const ARRIVAL_STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: "등원",
  absent: "미등원",
};

export const CLASS_STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: "출석",
  absent: "결석",
};

const SEOUL_WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** 서울 기준 YYYY-MM-DD */
export function seoulDateString(date: Date = new Date()): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/** 서울 기준 요일(월=1 ~ 일=7) */
export function seoulWeekday(date: Date = new Date()): number {
  const short = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(date);
  return SEOUL_WEEKDAY[short] ?? 1;
}

/** 서울 기준 "HH:mm"(24시간, 자정은 00) */
export function formatSeoulHHmm(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hh = parts.find((x) => x.type === "hour")?.value ?? "00";
  const mm = parts.find((x) => x.type === "minute")?.value ?? "00";
  return `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`;
}

/** 그 요일의 칸(시작 순) */
export function slotsOnWeekday<T extends ScheduleSlotLike>(schedule: readonly T[], weekday: number): T[] {
  return schedule
    .filter((s) => s.weekday === weekday)
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

/** "15:00~17:00" — 여러 칸이면 ", "로 */
export function slotsLabel(slots: readonly { start: string; end: string }[]): string {
  return slots.map((s) => `${s.start}~${s.end}`).join(", ");
}

/** 등원·미등원 알림 문구(2-I 결정 4장) */
export function arrivalPushBody(studentName: string, status: AttendanceStatus, at: Date): string {
  const time = formatSeoulHHmm(at);
  return status === "present"
    ? `${studentName} 학생이 안전하게 등원하였습니다. (알림 전송 시각 ${time})`
    : `${studentName} 학생이 아직 등원하지 않았습니다. (알림 전송 시각 ${time})`;
}

/** 반 출석·결석 알림 문구(2-I 결정 4장) */
export function classPushBody(
  studentName: string,
  className: string,
  status: AttendanceStatus,
  slots: readonly { start: string; end: string }[],
  at: Date,
): string {
  const verb = status === "present" ? "출석하였습니다" : "결석하였습니다";
  return `${studentName} 학생이 ${className} 수업에 ${verb}. (수업 시간 ${slotsLabel(slots)} / 알림 전송 시각 ${formatSeoulHHmm(at)})`;
}

/** 반 출결 문서 ID */
export function classAttendanceDocId(date: string, classId: string, studentId: string): string {
  return `${date}_${classId}_${studentId}`;
}

/** 상태 바뀜 알림 하루 최대 횟수(맥락·원생별) */
export const ATTENDANCE_DAILY_CHANGE_PUSH_LIMIT = 10;
