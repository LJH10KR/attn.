/**
 * 2-I 등원·반 출결 판단 — 조건 코드, 상태 전환, 알림 문구, 서울 시각(2-J: 취소 판단·취소 문구, 3-A: 정정 판단·사유).
 * `src/lib/academy/attendance-rules.ts`와 같은 내용(student-profile·permissions처럼 두 곳을 함께 맞춘다).
 * 서버가 실제로 막고, 화면은 같은 코드로 버튼을 옅게 하고 이유를 붙인다.
 */

export type AttendanceStatus = "present" | "absent";

/** 반 출결 상태(3-B: 지각 추가 — 사람이 직접, 분은 `lateMinutes`) */
export type ClassStatus = "present" | "late" | "absent";

export function isClassStatusValue(raw: unknown): raw is ClassStatus {
  return raw === "present" || raw === "late" || raw === "absent";
}

/** 문서 값 → 반 출결 상태(모르는 값은 출석 — 예전 두 값 매핑과 같은 기본) */
export function classStatusOf(raw: unknown): ClassStatus {
  return raw === "absent" ? "absent" : raw === "late" ? "late" : "present";
}

export type ScheduleSlotLike = { weekday: number; start: string; end: string };

/** 반 출결을 막는 이유(검사 순서대로) */
export const CLASS_ATTENDANCE_BLOCKS = [
  "inactive_student",
  "not_member",
  "class_ended",
  "no_lesson_today",
  "class_cancelled",
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
  class_cancelled: "휴강",
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
  class_cancelled: "휴강한 수업이라 출결을 기록할 수 없습니다. 휴강을 먼저 취소해 주세요.",
  not_arrived: "아직 등원 처리되지 않았습니다. 등원 처리 후 기록해 주세요.",
  billed_absent: "청구서 결석 차감에 반영된 날입니다. 청구서에서 차감을 삭제한 뒤 등원 처리해 주세요.",
  absent_today: "오늘 미등원으로 기록된 학생입니다. 등원 처리 후 기록해 주세요.",
};

/** 그날 등원 기록 요약 — 문서가 없으면 null(3-B: `departed` = 하원 기록 있음) */
export type ArrivalSnapshot = { status: AttendanceStatus; billed: boolean; departed?: boolean } | null;

export function classAttendanceBlock(params: {
  studentActive: boolean;
  isMember: boolean;
  classEnded: boolean;
  hasLessonToday: boolean;
  arrival: ArrivalSnapshot;
  /** 3-B 그날 그 반 휴강 */
  classCancelled?: boolean;
}): ClassAttendanceBlock | null {
  if (!params.studentActive) return "inactive_student";
  if (!params.isMember) return "not_member";
  if (params.classEnded) return "class_ended";
  if (!params.hasLessonToday) return "no_lesson_today";
  if (params.classCancelled) return "class_cancelled";
  if (!params.arrival) return "not_arrived";
  if (params.arrival.status === "absent") return params.arrival.billed ? "billed_absent" : "absent_today";
  return null;
}

/**
 * 등원 기록 전환 판단(버튼).
 * - unchanged: 같은 상태 — 기록·알림 그대로
 * - billed: 차감 잠금 날짜 — 바꾸지 않음
 * - has_class_records: 등원 → 미등원인데 그날 반 출결이 있음
 * - has_departure: 등원 → 미등원인데 하원 기록이 있음(3-B H3 — 하원 기록을 먼저 취소)
 */
export type ArrivalTransition = "ok" | "unchanged" | "billed" | "has_class_records" | "has_departure";

export function arrivalTransition(
  prev: ArrivalSnapshot,
  next: AttendanceStatus,
  classRecordCount: number,
): ArrivalTransition {
  if (prev && prev.status === next) return "unchanged";
  if (prev?.billed) return "billed";
  if (next === "absent" && classRecordCount > 0) return "has_class_records";
  if (next === "absent" && prev?.departed) return "has_departure";
  return "ok";
}

export const ARRIVAL_STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: "등원",
  absent: "미등원",
};

export const CLASS_STATUS_LABELS: Record<ClassStatus, string> = {
  present: "출석",
  late: "지각",
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

/** 반 출석·지각·결석 알림 문구(2-I 결정 4장, 3-B ⑤ 지각 "지각하였습니다(10분)") */
export function classPushBody(
  studentName: string,
  className: string,
  status: ClassStatus,
  slots: readonly { start: string; end: string }[],
  at: Date,
  lateMinutes?: number | null,
): string {
  const verb =
    status === "present"
      ? "출석하였습니다"
      : status === "late"
        ? `지각하였습니다${lateMinutes ? `(${lateMinutes}분)` : ""}`
        : "결석하였습니다";
  return `${studentName} 학생이 ${className} 수업에 ${verb}. (수업 시간 ${slotsLabel(slots)} / 알림 전송 시각 ${formatSeoulHHmm(at)})`;
}

/**
 * 등원 기록 취소 판단(2-J) — 기록이 있을 때만 부른다. 검사 순서: 반 출결 → 차감 잠금 → 사유.
 * - has_class_records: 그날 반 출결이 있음(출석·결석을 먼저 취소)
 * - billed: 차감 잠금 날짜
 * - reason_locked: 질병·학원 사정 미등원(월정액 차감 근거 — 출결 권한의 출결 탭에서만 정정)
 * 등원, 기타(general)·사유 없는 예전 미등원은 null(취소 가능).
 * 3-B H3: 반 출결 다음에 하원 기록(has_departure — 하원 기록을 먼저 취소).
 */
export type ArrivalCancelBlock = "has_class_records" | "has_departure" | "billed" | "reason_locked";

export function arrivalCancelBlock(params: {
  status: AttendanceStatus;
  reason: string | null;
  billed: boolean;
  classRecordCount: number;
  departed?: boolean;
}): ArrivalCancelBlock | null {
  if (params.classRecordCount > 0) return "has_class_records";
  if (params.departed) return "has_departure";
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

/** 반 출석·지각·결석 기록 취소 알림 문구(2-J, 3-B 지각) */
export function classCancelPushBody(
  studentName: string,
  className: string,
  status: ClassStatus,
  at: Date,
): string {
  const what = status === "present" ? "수업 출석 기록" : status === "late" ? "수업 지각 기록" : "수업 결석 기록";
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
  /** 3-B 하원 기록 있음 */
  departed?: boolean;
} | null;

/**
 * 지난 날짜 등원 기록 정정 판단 — 검사 순서: 같은 내용 → 차감 잠금 → 반 출결.
 * - unchanged: 바꿀 것이 없음(등원이면 시각까지 같을 때, 미등원이면 사유까지 같을 때 — B4)
 * - billed: 차감 잠금 날(상태·삭제·사유·시각 모두 거부, 메모는 `updateAttendanceDetails`로)
 * - has_class_records: 등원 → 미등원·삭제인데 그날 반 출결이 있음
 * - has_departure: 등원 → 미등원·삭제인데 하원 기록이 있음(3-B H3)
 */
export type ArrivalCorrectionCheck = "ok" | "unchanged" | "billed" | "has_class_records" | "has_departure";

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
  if (leavesPresent && prev?.departed) return "has_departure";
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
  next: ClassStatus | null;
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

/*
 * ── 3-B 지각·하원·휴강·알림 종류·다시 보내기 ── 결정 `docs/stage3-handoff/3-B-decisions.md`, 계획 `3-B-plan.md`.
 * 지각은 서버가 판정하지 않는다(사람이 분을 골라 보냄 — B1). 하원은 등원 기록(날짜) 쪽(2-I ★3).
 */

/** 지각 분 범위(B1 ②) */
export const LATE_MINUTES_MIN = 1;
export const LATE_MINUTES_MAX = 180;
export const LATE_MINUTES_MESSAGE = `지각 시간은 ${LATE_MINUTES_MIN}~${LATE_MINUTES_MAX}분으로 입력해 주세요.`;

export function isLateMinutes(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= LATE_MINUTES_MIN && raw <= LATE_MINUTES_MAX;
}

/**
 * 지각 창 미리 채움(화면에서만, B1 ②) — 그날 등원 시각 − 그 반 수업 시작(분, 내림).
 * 등원 시각이 없거나 시작 전·같은 분이면 null, 180분을 넘으면 null(직접 입력).
 */
export function suggestLateMinutes(arrivedAtMs: number | null, date: string, slotStart: string | null): number | null {
  if (arrivedAtMs === null || !slotStart || !isHHmm(slotStart)) return null;
  const minutes = Math.floor((arrivedAtMs - seoulDateTimeMs(date, slotStart)) / 60_000);
  return isLateMinutes(minutes) ? minutes : null;
}

/** 줄 칩 "지각 12분" */
export function lateLabel(lateMinutes: number | null | undefined): string {
  return lateMinutes ? `지각 ${lateMinutes}분` : "지각";
}

/**
 * 하원 판단(B4·B10·H2·H3) — 등원 기록 요약을 보고.
 * - no_arrival: 그날 등원 기록이 없음(H2 — 시각을 지어내지 않음)
 * - absent_day: 미등원으로 기록된 날
 * - already_left: 이미 하원(H3 — 기록·알림 그대로)
 * 차감 잠금 날도 허용(하원은 원비와 무관, H3).
 */
export type DepartureBlock = "no_arrival" | "absent_day" | "already_left";

export function departureBlock(arrival: ArrivalSnapshot): DepartureBlock | null {
  if (!arrival) return "no_arrival";
  if (arrival.status === "absent") return "absent_day";
  if (arrival.departed) return "already_left";
  return null;
}

/** 직원 버튼 문구(키오스크는 `DEPARTURE_KIOSK_NO_ARRIVAL_MESSAGE`) */
export const DEPARTURE_BLOCK_MESSAGES: Record<Exclude<DepartureBlock, "already_left">, string> = {
  no_arrival: "오늘 등원 기록이 없어 하원 처리할 수 없습니다. 등원을 먼저 기록해 주세요.",
  absent_day: "오늘 미등원으로 기록된 학생이라 하원 처리할 수 없습니다.",
};

/** 키오스크 하원(H2) — 등원 기록이 없거나 미등원인 날 */
export const DEPARTURE_KIOSK_NO_ARRIVAL_MESSAGE = "오늘 등원 기록이 없어요. 선생님께 말씀해 주세요.";

export const ALREADY_LEFT_MESSAGE = "이미 하원 처리되었습니다.";

/** 하원이 있어 오늘 미등원·등원 취소를 막을 때(H3) */
export function departureLockTodayMessage(cancelling: boolean): string {
  return `하원 기록이 있어 ${cancelling ? "등원 기록을 취소할" : "미등원으로 바꿀"} 수 없습니다. 하원 기록을 먼저 취소해 주세요.`;
}

/** 하원이 있어 지난 날짜 미등원·지우기·삭제를 막을 때(H3) */
export function departureLockPastMessage(date: string, deleting: boolean): string {
  return `${dateLabel(date)}에는 하원 기록이 있어 ${deleting ? "등원 기록을 지울" : "미등원으로 바꿀"} 수 없습니다. 하원 기록을 먼저 정정해 주세요.`;
}

/** 하원 시각이 등원 시각보다 앞(★6) */
export const DEPARTURE_BEFORE_ARRIVAL_MESSAGE = "하원 시각은 등원 시각보다 빠를 수 없습니다.";

/** 오늘 기록을 정정 함수로 고칠 때 — 시각만(★7) */
export const TODAY_TIME_ONLY_MESSAGE = "오늘 기록은 시각만 고칠 수 있습니다. 상태는 출결 버튼으로 처리해 주세요.";

/** 일괄 출석·결석에서 지각 줄을 건너뛸 때(★3·R2) */
export const BATCH_LATE_ROW_MESSAGE = "지각으로 기록되어 있어 건너뛰었습니다. 줄에서 바꿔 주세요.";

/** 오늘 기록 시각이 지금보다 늦을 때(R1) */
export const TODAY_FUTURE_TIME_MESSAGE = "오늘 기록은 지금보다 늦은 시각으로 고칠 수 없습니다.";

/**
 * 오늘 기록 시각 고치기(★7·R1) — "HH:mm" 필수(undefined·null 지우기 불가 → time_only),
 * 지금(서울, 분 단위)보다 늦으면 future.
 */
export function todayTimeBlock(time: unknown, now: Date = new Date()): "time_only" | "future" | null {
  if (!isHHmm(time)) return "time_only";
  return time > formatSeoulHHmm(now) ? "future" : null;
}

/** 하원 알림 문구(B5) */
export function departurePushBody(studentName: string, at: Date): string {
  return `${studentName} 학생이 하원하였습니다. (알림 전송 시각 ${formatSeoulHHmm(at)})`;
}

/** 하원 기록 취소 알림 문구 */
export function departureCancelPushBody(studentName: string, at: Date): string {
  return `${studentName} 학생의 하원 기록이 취소되었습니다. (알림 전송 시각 ${formatSeoulHHmm(at)})`;
}

/** 다시 보내기 문구 앞(B9) */
export const RESEND_PREFIX = "(다시 알림) ";

/** 다시 보내기 문구 — 저장 문구에 붙은 앞 글자를 떼고 한 번만 붙인다(R3) */
export function resendBody(body: string): string {
  let rest = body;
  while (rest.startsWith(RESEND_PREFIX)) rest = rest.slice(RESEND_PREFIX.length);
  return `${RESEND_PREFIX}${rest}`;
}

/**
 * 휴강 판단(B7·★11·P1). 오늘 = 반 있음·종강 아님·그 요일 수업 있음·그날 그 반 출결 0건,
 * 지난 날짜 = 반 있음 + 출결 0건만(3-A A4 — 재원·종강·그날 수업은 다시 보지 않음, 원장 판단).
 */
export type ClassCancellationBlock = "future" | "class_missing" | "class_ended" | "no_lesson" | "has_records";

export function classCancellationBlock(params: {
  date: string;
  today: string;
  classExists: boolean;
  classEnded: boolean;
  hasLesson: boolean;
  recordCount: number;
}): ClassCancellationBlock | null {
  if (params.date > params.today) return "future";
  if (!params.classExists) return "class_missing";
  if (params.date === params.today) {
    if (params.classEnded) return "class_ended";
    if (!params.hasLesson) return "no_lesson";
  }
  if (params.recordCount > 0) return "has_records";
  return null;
}

export function classCancellationBlockMessage(
  block: ClassCancellationBlock,
  p: { date: string; className: string; recordCount: number },
): string {
  switch (block) {
  case "future":
    return "앞으로의 날짜는 휴강으로 기록할 수 없습니다.";
  case "class_missing":
    return "반을 찾을 수 없습니다.";
  case "class_ended":
    return "종강한 반은 휴강으로 기록할 수 없습니다.";
  case "no_lesson":
    return "오늘은 이 반 수업이 없어 휴강으로 기록할 수 없습니다.";
  case "has_records":
    return `${dateLabel(p.date)} ${p.className} 수업 출결 기록이 ${p.recordCount}건 있어 휴강으로 기록할 수 없습니다. 출결을 먼저 정정해 주세요.`;
  }
}

export const CLASS_CANCELLATION_MEMO_MAX_LENGTH = 200;

/** 휴강 문서 ID */
export function classCancellationDocId(date: string, classId: string): string {
  return `${date}_${classId}`;
}

/** 학원 단위 알림 종류(B6) — 설정 문서 `meta/attendanceSettings.notify`의 키 */
export const ATTENDANCE_NOTIFY_TYPES = [
  "arrival",
  "arrivalAbsent",
  "departure",
  "classPresent",
  "classLate",
  "classAbsent",
  "correction",
] as const;
export type AttendanceNotifyType = (typeof ATTENDANCE_NOTIFY_TYPES)[number];

export const ATTENDANCE_NOTIFY_TYPE_LABELS: Record<AttendanceNotifyType, string> = {
  arrival: "등원",
  arrivalAbsent: "미등원",
  departure: "하원",
  classPresent: "수업 출석",
  classLate: "수업 지각",
  classAbsent: "수업 결석",
  correction: "정정(취소)",
};

/** 알림 맥락 */
export type AttendanceNotifyContextName = "arrival" | "class" | "departure";
/** 알림 기록 kind — 등원 맥락 present/absent, 반 present/late/absent, 하원 left */
export type AttendanceNotifyKind = "present" | "late" | "absent" | "left";

/**
 * 알림 한 건의 **원래 종류**(★8: 기간 결석 요약 = 미등원, 키오스크 등원 = 등원).
 * 취소 알림이면 취소한 기록의 종류(kind = 취소한 기록의 상태) — 켜짐 판단은 `isNotifyEnabled`.
 */
export function notifyTypeFor(p: {
  context: AttendanceNotifyContextName;
  kind: AttendanceNotifyKind;
}): AttendanceNotifyType {
  if (p.context === "departure") return "departure";
  if (p.context === "class") return p.kind === "late" ? "classLate" : p.kind === "absent" ? "classAbsent" : "classPresent";
  return p.kind === "absent" ? "arrivalAbsent" : "arrival";
}

/**
 * 이 알림을 보낼지(3-B 후속 F2) — 기록 알림 = 원래 종류가 켜짐,
 * 취소(정정) 알림 = 원래 종류 **그리고** 정정이 켜짐(받은 적 없는 알림의 취소는 보내지 않음).
 * 서버 전송·다시 보내기·알림 기록 화면 [다시 보내기]가 함께 쓴다.
 */
export function isNotifyEnabled(
  settings: Record<AttendanceNotifyType, boolean>,
  p: { context: AttendanceNotifyContextName; kind: AttendanceNotifyKind; action?: "record" | "cancel" | null },
): boolean {
  const base = settings[notifyTypeFor(p)];
  return p.action === "cancel" ? base && settings.correction : base;
}

/** 설정 문서의 `notify` → 종류별 켜짐(false로 적힌 것만 끔 — 기본 모두 켬) */
export function readNotifySettings(raw: unknown): Record<AttendanceNotifyType, boolean> {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<AttendanceNotifyType, boolean>;
  for (const t of ATTENDANCE_NOTIFY_TYPES) out[t] = src[t] !== false;
  return out;
}

/**
 * 다시 보내기 — 지금 기록이 그 알림과 같은 상태인지(B9).
 * `arrival`: 그날 등원 기록(없으면 null), `classStatus`: 그날 그 반 출결(없으면 null).
 */
export function resendStateMatches(
  item: {
    context: AttendanceNotifyContextName;
    kind: AttendanceNotifyKind;
    action: "record" | "cancel";
    reason?: string | null;
    origin?: string | null;
  },
  now: {
    arrival: { status: AttendanceStatus; reason: string | null; departed: boolean } | null;
    classStatus: ClassStatus | null;
  },
): boolean {
  const { arrival, classStatus } = now;
  if (item.context === "departure") {
    return item.action === "cancel" ? arrival?.status === "present" && !arrival.departed : arrival?.departed === true;
  }
  if (item.context === "class") {
    return item.action === "cancel" ? classStatus === null : classStatus === item.kind;
  }
  if (item.action === "cancel") return arrival === null;
  if (item.kind === "present") return arrival?.status === "present";
  if (arrival?.status !== "absent") return false;
  // 기간 결석 요약은 사유까지 같아야 같은 알림
  return item.origin === "absence_period" ? (arrival.reason ?? null) === (item.reason ?? null) : true;
}

export const RESEND_MESSAGES = {
  notToday: "오늘 보낸 알림만 다시 보낼 수 있습니다.",
  stateChanged: "지금 출결 기록이 이 알림과 달라 다시 보낼 수 없습니다.",
  muted: "출결 설정에서 꺼 둔 알림이라 다시 보낼 수 없습니다.",
  notFound: "알림 기록을 찾을 수 없습니다.",
  permission: "알림 다시 보내기는 원장이나 출결 권한이 있는 직원만 할 수 있습니다.",
} as const;
