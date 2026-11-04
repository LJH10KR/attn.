import type { AcademyClassScheduleSlot } from "@/lib/firebase/attn-schema";

/**
 * 반 수업 시간 — 저장은 칸 단위 `{weekday 1(월)~7(일), start, end}`(서버 `functions/src/lib/class-schedule.ts`).
 * 2-I부터 **한 반은 요일당 1칸**(하루 두 번 수업하면 반을 따로 만든다, 결정 3-3) → 최대 7칸.
 * 편집은 "요일 고르기 → 시간 하나(기본)", "요일마다 다름"이면 고른 요일마다 시간(`ScheduleDraft`).
 * 다른 반·강의실끼리는 검사하지 않는다(견적서 4-2).
 */

export const MAX_SCHEDULE_SLOTS = 7;
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const WEEKDAY_LABELS: Record<number, string> = {
  1: "월",
  2: "화",
  3: "수",
  4: "목",
  5: "금",
  6: "토",
  7: "일",
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export type ScheduleGroup = { key: string; weekdays: number[]; start: string; end: string };

let groupSeq = 0;
export function newScheduleGroupKey(): string {
  groupSeq += 1;
  return `sg-${groupSeq}`;
}

export function compareSlots(a: AcademyClassScheduleSlot, b: AcademyClassScheduleSlot): number {
  return a.weekday - b.weekday || a.start.localeCompare(b.start) || a.end.localeCompare(b.end);
}

export function sortSlots(slots: readonly AcademyClassScheduleSlot[]): AcademyClassScheduleSlot[] {
  return [...slots].sort(compareSlots);
}

/** 요일·시작·끝 순으로 정렬한 칸끼리 비교 — 줄 묶음 순서만 다르면 같은 시간표 */
export function sameSchedule(
  a: readonly AcademyClassScheduleSlot[],
  b: readonly AcademyClassScheduleSlot[],
): boolean {
  const key = (s: readonly AcademyClassScheduleSlot[]) =>
    JSON.stringify(sortSlots(s).map((x) => [x.weekday, x.start, x.end]));
  return key(a) === key(b);
}

/** 저장된 칸 → 편집 줄(시작·끝이 같은 칸끼리 한 줄) */
export function groupSchedule(slots: readonly AcademyClassScheduleSlot[]): ScheduleGroup[] {
  const byTime = new Map<string, ScheduleGroup>();
  for (const s of sortSlots(slots)) {
    const k = `${s.start}|${s.end}`;
    const g = byTime.get(k);
    if (g) {
      if (!g.weekdays.includes(s.weekday)) g.weekdays.push(s.weekday);
    } else {
      byTime.set(k, { key: newScheduleGroupKey(), weekdays: [s.weekday], start: s.start, end: s.end });
    }
  }
  return [...byTime.values()].sort(
    (a, b) => (a.weekdays[0] ?? 0) - (b.weekdays[0] ?? 0) || a.start.localeCompare(b.start),
  );
}

export type TimeRange = { start: string; end: string };

/** 편집 상태 — 고른 요일, 요일마다 다름 여부, 공통 시간, 요일별 시간 */
export type ScheduleDraft = {
  weekdays: number[];
  perDay: boolean;
  common: TimeRange;
  byDay: Record<number, TimeRange>;
};

const DEFAULT_TIME: TimeRange = { start: "16:00", end: "17:00" };

/** 같은 요일에 두 칸 이상(2-I 이전에 저장된 반) */
export function hasDuplicateWeekday(slots: readonly AcademyClassScheduleSlot[]): boolean {
  return new Set(slots.map((s) => s.weekday)).size !== slots.length;
}

/** 두 칸 이상인 요일의 칸 전부(요일·시작 순) — 수정 시트 안내용 */
export function duplicateWeekdaySlots(slots: readonly AcademyClassScheduleSlot[]): AcademyClassScheduleSlot[] {
  const count = new Map<number, number>();
  slots.forEach((s) => count.set(s.weekday, (count.get(s.weekday) ?? 0) + 1));
  return sortSlots(slots.filter((s) => (count.get(s.weekday) ?? 0) > 1));
}

/** 저장된 칸 → 편집 상태. 요일마다 첫 칸만 쓰고(예전 중복 데이터), 시간이 모두 같으면 기본 형태 */
export function draftFromSchedule(slots: readonly AcademyClassScheduleSlot[]): ScheduleDraft {
  const byDay: Record<number, TimeRange> = {};
  for (const s of sortSlots(slots)) {
    if (!byDay[s.weekday]) byDay[s.weekday] = { start: s.start, end: s.end };
  }
  const weekdays = Object.keys(byDay).map(Number).sort((a, b) => a - b);
  const times = weekdays.map((d) => byDay[d]!);
  const first = times[0] ?? DEFAULT_TIME;
  const perDay = times.some((t) => t.start !== first.start || t.end !== first.end);
  return { weekdays, perDay, common: { ...first }, byDay };
}

/** 편집 상태 → 칸(요일 순) */
export function draftToSlots(draft: ScheduleDraft): AcademyClassScheduleSlot[] {
  return [...draft.weekdays]
    .sort((a, b) => a - b)
    .map((weekday) => {
      const t = draft.perDay ? draft.byDay[weekday] ?? draft.common : draft.common;
      return { weekday, start: t.start, end: t.end };
    });
}

/** "요일마다 다름" 켜기·끄기 — 켜면 공통 시간을 각 요일에 복사, 끄면 첫 요일 시간으로 맞춤 */
export function setDraftPerDay(draft: ScheduleDraft, perDay: boolean): ScheduleDraft {
  if (perDay === draft.perDay) return draft;
  if (perDay) {
    const byDay: Record<number, TimeRange> = { ...draft.byDay };
    draft.weekdays.forEach((d) => {
      byDay[d] = { ...draft.common };
    });
    return { ...draft, perDay, byDay };
  }
  const firstDay = [...draft.weekdays].sort((a, b) => a - b)[0];
  const common = firstDay !== undefined && draft.byDay[firstDay] ? { ...draft.byDay[firstDay]! } : draft.common;
  return { ...draft, perDay, common };
}

/** "요일마다 다름"을 끌 때 시간이 서로 달라 하나로 맞춰지는지 */
export function draftPerDayDiffers(draft: ScheduleDraft): boolean {
  const times = draft.weekdays.map((d) => draft.byDay[d] ?? draft.common);
  return times.some((t) => t.start !== times[0]!.start || t.end !== times[0]!.end);
}

/** 요일 켜기·끄기 — 새로 켠 요일은 공통 시간(요일마다 다름이면 마지막 요일 시간)으로 */
export function toggleDraftWeekday(draft: ScheduleDraft, day: number): ScheduleDraft {
  if (draft.weekdays.includes(day)) {
    return { ...draft, weekdays: draft.weekdays.filter((d) => d !== day) };
  }
  const weekdays = [...draft.weekdays, day].sort((a, b) => a - b);
  const byDay = { ...draft.byDay };
  if (!byDay[day]) {
    const prev = [...draft.weekdays].sort((a, b) => a - b).filter((d) => d < day).pop();
    byDay[day] = { ...(draft.perDay && prev !== undefined ? draft.byDay[prev] ?? draft.common : draft.common) };
  }
  return { ...draft, weekdays, byDay };
}

/** 저장을 막는 오류(서버와 같은 조건 — 요일당 1칸은 편집 형태가 보장) — 없으면 null */
export function scheduleDraftError(draft: ScheduleDraft): string | null {
  for (const s of draftToSlots(draft)) {
    const label = draft.perDay ? `${WEEKDAY_LABELS[s.weekday]}요일 ` : "";
    if (!TIME_RE.test(s.start) || !TIME_RE.test(s.end)) return `${label}시작·끝 시간을 입력해 주세요.`;
    if (s.start >= s.end) return `${label}끝 시간은 시작 시간보다 늦어야 합니다.`;
  }
  return null;
}

/** "월·수 16:00–17:00 · 금 18:00–19:30" — 없으면 빈 문자열 */
export function scheduleSummary(slots: readonly AcademyClassScheduleSlot[]): string {
  return groupSchedule(slots)
    .map((g) => `${g.weekdays.map((d) => WEEKDAY_LABELS[d]).join("·")} ${g.start}–${g.end}`)
    .join(" · ");
}

const SEOUL_WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** 서울 기준 오늘 요일(월=1~일=7) */
export function seoulWeekday(now: Date = new Date()): number {
  const short = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(now);
  return SEOUL_WEEKDAY[short] ?? 1;
}

/** 그 요일의 칸(시작 순) */
export function slotsOnWeekday(
  slots: readonly AcademyClassScheduleSlot[],
  weekday: number,
): AcademyClassScheduleSlot[] {
  return sortSlots(slots).filter((s) => s.weekday === weekday);
}
