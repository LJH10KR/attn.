/**
 * 2-I 등원·반 출결 판단 — 조건 코드, 상태 전환, 알림 문구, 서울 시각(2-J: 취소 판단·취소 문구, 3-A: 정정 판단·사유).
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

/**
 * 등원 기록 취소 판단(2-J) — 기록이 있을 때만 부른다. 검사 순서: 반 출결 → 차감 잠금 → 사유.
 * - has_class_records: 그날 반 출결이 있음(출석·결석을 먼저 취소)
 * - billed: 차감 잠금 날짜
 * - reason_locked: 질병·학원 사정 미등원(월정액 차감 근거 — 출결 권한의 출결 탭에서만 정정)
 * 등원, 기타(general)·사유 없는 예전 미등원은 null(취소 가능).
 */
export type ArrivalCancelBlock = "has_class_records" | "billed" | "reason_locked";

export function arrivalCancelBlock(params: {
  status: AttendanceStatus;
  reason: string | null;
  billed: boolean;
  classRecordCount: number;
}): ArrivalCancelBlock | null {
  if (params.classRecordCount > 0) return "has_class_records";
  if (params.billed) return "billed";
  if (params.status === "absent" && (params.reason === "illness" || params.reason === "academy")) {
    return "reason_locked";
  }
  return null;
}

/** 질병·학원 사정 미등원 등원 취소 거부 문구(2-J ★7) */
export const ARRIVAL_CANCEL_REASON_LOCKED_MESSAGE =
  "질병·학원 사정 미등원은 여기서 취소할 수 없습니다. 출결 권한이 있는 분이 학생 상세 출결 탭에서 정정해 주세요.";

/** 반 출결이 있어 등원 취소를 막을 때 문구 */
export function arrivalCancelClassRecordsMessage(count: number): string {
  return `오늘 수업 출결이 ${count}건 있어 등원 기록을 취소할 수 없습니다. 출석·결석 기록을 먼저 취소해 주세요.`;
}

/** 오늘이 아닌 날짜 취소 거부 문구(2-J ★2) */
export const CANCEL_NOT_TODAY_MESSAGE = "오늘 기록만 취소할 수 있습니다. 화면을 새로고침해 주세요.";

/** 등원·미등원 기록 취소 알림 문구(2-J) */
export function arrivalCancelPushBody(studentName: string, status: AttendanceStatus, at: Date): string {
  const what = status === "present" ? "등원 기록" : "미등원 기록";
  return `${studentName} 학생의 ${what}이 취소되었습니다. (알림 전송 시각 ${formatSeoulHHmm(at)})`;
}

/** 반 출석·결석 기록 취소 알림 문구(2-J) */
export function classCancelPushBody(
  studentName: string,
  className: string,
  status: AttendanceStatus,
  at: Date,
): string {
  const what = status === "present" ? "수업 출석 기록" : "수업 결석 기록";
  return `${studentName} 학생의 ${className} ${what}이 취소되었습니다. (알림 전송 시각 ${formatSeoulHHmm(at)})`;
}

/** 반 출결 문서 ID */
export function classAttendanceDocId(date: string, classId: string, studentId: string): string {
  return `${date}_${classId}_${studentId}`;
}

/** 상태 바뀜 알림 하루 최대 횟수(맥락·원생별) */
export const ATTENDANCE_DAILY_CHANGE_PUSH_LIMIT = 10;

/*
 * ── 3-A 지난 날짜 정정·사유와 코멘트 ── 결정 `docs/stage3-handoff/3-A-start.md`, 계획 `3-A-plan.md`.
 * 정정은 알림이 없고(Q3) 정정 이력을 남긴다. 지키는 불변식은 오늘과 같다:
 * 반 출결은 그날 등원일 때만 / 반 출결이 있는 날은 등원을 미등원·삭제로 못 바꿈 / 차감 잠금 날 등원 기록 거부.
 */

/** 결석(미등원·반 결석) 사유 — 두 층 같은 코드(A7). general의 화면 이름은 "기타" */
export const ABSENCE_REASONS = ["illness", "academy", "general"] as const;
export type AbsenceReason = (typeof ABSENCE_REASONS)[number];

export const ABSENCE_REASON_LABELS: Record<AbsenceReason, string> = {
  illness: "질병",
  academy: "학원 사정",
  general: "기타",
};

export function isAbsenceReason(raw: unknown): raw is AbsenceReason {
  return typeof raw === "string" && (ABSENCE_REASONS as readonly string[]).includes(raw);
}

/** 메모(등원 기록 `note`)·코멘트(반 출결 `comment`) 최대 길이 */
export const ATTENDANCE_NOTE_MAX_LENGTH = 200;

/**
 * 상태가 바뀔 때 사유(★3) — 등원·출석이면 없음, 미등원·결석이면 이전 사유(없으면 기타).
 * 메모·코멘트는 상태와 상관없이 유지한다(호출하는 쪽에서 건드리지 않음).
 */
export function reasonForStatus(status: AttendanceStatus, prevReason: unknown): AbsenceReason | null {
  if (status === "present") return null;
  return isAbsenceReason(prevReason) ? prevReason : "general";
}

/** "YYYY-MM-DD"가 실제 날짜인지 */
export function isValidDateString(raw: unknown): raw is string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const ms = new Date(`${raw}T12:00:00+09:00`).getTime();
  return Number.isFinite(ms) && seoulDateString(new Date(ms)) === raw;
}

/** 날짜 문자열의 서울 요일(월=1 ~ 일=7) */
export function weekdayOfDate(date: string): number {
  return seoulWeekday(new Date(`${date}T12:00:00+09:00`));
}

/** "2026-11-05" → "11월 5일" */
export function dateLabel(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}월 ${d}일`;
}

/** "HH:mm"(00:00~23:59)인지 */
export function isHHmm(raw: unknown): raw is string {
  return typeof raw === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw);
}

/** 서울 날짜 + "HH:mm" → ms */
export function seoulDateTimeMs(date: string, hhmm: string): number {
  return new Date(`${date}T${hhmm}:00+09:00`).getTime();
}

/** 정정 날짜 판단 — 서울 오늘보다 앞이어야 함 */
export function correctionDateBlock(date: string, today: string): "today" | "future" | null {
  if (date === today) return "today";
  return date > today ? "future" : null;
}

export const CORRECTION_DATE_MESSAGES: Record<"today" | "future", string> = {
  today: "지난 날짜만 정정할 수 있습니다. 오늘 기록은 출결 버튼으로 처리해 주세요.",
  future: "앞으로의 날짜는 정정할 수 없습니다.",
};

export const CORRECTION_PERMISSION_MESSAGE =
  "지난 날짜 출결은 원장이나 출결 권한이 있는 직원만 정정할 수 있습니다.";

export const DETAILS_PERMISSION_MESSAGE = "출결 사유·메모는 원장이나 출결 권한이 있는 직원만 바꿀 수 있습니다.";

/** 오늘 기록 함수에 오늘이 아닌 날짜가 온 경우(B1 — 화면이 자정을 넘긴 채 열려 있음) */
export const RECORD_NOT_TODAY_MESSAGE = "오늘 기록만 처리할 수 있습니다. 화면을 새로고침해 주세요.";

export const SESSION_DEDUCTION_LOCKED_MESSAGE = "회차 차감이 연결된 기록이라 정정할 수 없습니다.";

export const REASON_NOT_ABSENT_MESSAGE = "사유는 미등원·결석 기록에만 고를 수 있습니다.";

/** 지난 날짜 등원 기록 정정의 다음 상태(`null` = 기록 지우기) */
export type ArrivalCorrectionTarget = {
  status: AttendanceStatus | null;
  reason: AbsenceReason | null;
  /** 등원 시각 ms(시각 없음 = null) */
  arrivedAtMs: number | null;
};

/** 지금 등원 기록(정정 판단용) — 문서가 없으면 null */
export type ArrivalCorrectionPrev = {
  status: AttendanceStatus;
  billed: boolean;
  reason: string | null;
  arrivedAtMs: number | null;
} | null;

/**
 * 지난 날짜 등원 기록 정정 판단 — 검사 순서: 같은 내용 → 차감 잠금 → 반 출결.
 * - unchanged: 바꿀 것이 없음(등원이면 시각까지 같을 때, 미등원이면 사유까지 같을 때 — B4)
 * - billed: 차감 잠금 날(상태·삭제·사유·시각 모두 거부, 메모는 `updateAttendanceDetails`로)
 * - has_class_records: 등원 → 미등원·삭제인데 그날 반 출결이 있음
 */
export type ArrivalCorrectionCheck = "ok" | "unchanged" | "billed" | "has_class_records";

export function arrivalCorrectionCheck(
  prev: ArrivalCorrectionPrev,
  next: ArrivalCorrectionTarget,
  classRecordCount: number,
): ArrivalCorrectionCheck {
  if (!prev && next.status === null) return "unchanged";
  if (prev && prev.status === next.status) {
    const same =
      next.status === "present" ? prev.arrivedAtMs === next.arrivedAtMs : (prev.reason ?? null) === next.reason;
    if (same) return "unchanged";
  }
  if (prev?.billed) return "billed";
  const leavesPresent = next.status === null || (next.status === "absent" && prev?.status !== "absent");
  if (leavesPresent && classRecordCount > 0) return "has_class_records";
  return "ok";
}

export function arrivalCorrectionClassRecordsMessage(date: string, count: number, deleting: boolean): string {
  const what = deleting ? "등원 기록을 지울" : "미등원으로 바꿀";
  return `${dateLabel(date)}에는 수업 출결 기록이 ${count}건 있어 ${what} 수 없습니다. 수업 출결을 먼저 정정해 주세요.`;
}

/**
 * 지난 날짜 반 출결 정정 판단(만들기·바꾸기·지우기). 재원·종강·그날 수업은 보지 않는다(A4).
 * 검사 순서: 회차 차감 연결 → (지우기면 통과) → 반 원생 → 그날 등원.
 */
export type ClassCorrectionBlock = "session_deduction" | "not_member" | "not_arrived" | "absent_day";

export function classCorrectionBlock(params: {
  next: AttendanceStatus | null;
  recordExists: boolean;
  hasSessionDeduction: boolean;
  /** 현재 그 반 원생(`classIds`) */
  isMember: boolean;
  arrival: ArrivalSnapshot;
}): ClassCorrectionBlock | null {
  // 3-C 회차 자동 차감 연결 때 "차감을 되돌린 뒤"로 바꾼다(cancelClassAttendance ★4와 같은 자리)
  if (params.recordExists && params.hasSessionDeduction) return "session_deduction";
  if (params.next === null) return null;
  if (!params.recordExists && !params.isMember) return "not_member";
  if (!params.arrival) return "not_arrived";
  if (params.arrival.status === "absent") return "absent_day";
  return null;
}

export function classCorrectionBlockMessage(block: ClassCorrectionBlock, date: string): string {
  switch (block) {
  case "session_deduction":
    return SESSION_DEDUCTION_LOCKED_MESSAGE;
  case "not_member":
    return `이 반 원생이 아니어서 ${dateLabel(date)} 수업 출결을 새로 기록할 수 없습니다.`;
  case "not_arrived":
    return `${dateLabel(date)} 등원 기록이 없어 수업 출결을 기록할 수 없습니다. 등원 기록을 먼저 정정해 주세요.`;
  case "absent_day":
    return `${dateLabel(date)}은 미등원으로 기록되어 있어 수업 출결을 기록할 수 없습니다. 등원 기록을 먼저 정정해 주세요.`;
  }
}

/** 일괄 처리 최대 인원(★6) */
export const ATTENDANCE_BATCH_MAX = 50;

export const BATCH_MODE_MISMATCH_MESSAGE =
  "날짜가 바뀌어 처리 방식이 달라졌습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.";
