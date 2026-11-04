import { HttpsError } from "firebase-functions/v2/https";

/**
 * 반 수업 시간 — `{weekday 1(월)~7(일), start, end}` 칸. 2-I부터 **한 반은 요일당 1칸**
 * (하루 두 번 수업하면 반을 따로 만든다, 결정 3-3). 화면 `src/lib/academy/class-schedule.ts`와 같은 조건.
 */

export const MAX_SCHEDULE_SLOTS = 7;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export type ScheduleSlot = { weekday: number; start: string; end: string };

export const DUPLICATE_WEEKDAY_MESSAGE =
  "같은 요일에 수업 시간을 두 번 넣을 수 없습니다. 하루에 두 번 수업하면 반을 따로 만들어 주세요.";

/** 요일(월=1~일=7)마다 한 칸 — 시작 < 끝, 같은 요일 금지, 요일 순으로 정렬해 저장 */
export function parseSchedule(raw: unknown): ScheduleSlot[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpsError("invalid-argument", "수업 시간이 올바르지 않습니다.");
  if (raw.length > MAX_SCHEDULE_SLOTS) {
    throw new HttpsError("invalid-argument", `수업 시간은 요일마다 하나씩, 최대 ${MAX_SCHEDULE_SLOTS}개까지 등록할 수 있습니다.`);
  }
  const seen = new Set<number>();
  const slots = raw.map((x): ScheduleSlot => {
    const s = (x ?? {}) as Record<string, unknown>;
    const weekday = s.weekday;
    const start = s.start;
    const end = s.end;
    if (
      typeof weekday !== "number" || !Number.isInteger(weekday) || weekday < 1 || weekday > 7 ||
      typeof start !== "string" || !TIME_RE.test(start) ||
      typeof end !== "string" || !TIME_RE.test(end)
    ) {
      throw new HttpsError("invalid-argument", "수업 시간이 올바르지 않습니다.");
    }
    if (start >= end) {
      throw new HttpsError("invalid-argument", "수업 끝 시간은 시작 시간보다 늦어야 합니다.");
    }
    if (seen.has(weekday)) throw new HttpsError("invalid-argument", DUPLICATE_WEEKDAY_MESSAGE);
    seen.add(weekday);
    return { weekday, start, end };
  });
  return slots.sort((a, b) => a.weekday - b.weekday);
}

/** 저장된 시간표 읽기(예전 데이터 — 같은 요일 두 칸이 있을 수 있음) */
export function readSchedule(raw: unknown): ScheduleSlot[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const s = x as Record<string, unknown> | null;
    return s && typeof s.weekday === "number" && typeof s.start === "string" && typeof s.end === "string"
      ? [{ weekday: s.weekday, start: s.start, end: s.end }]
      : [];
  });
}
