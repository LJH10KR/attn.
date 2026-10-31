import type { AcademyClassScheduleSlot } from "@/lib/firebase/attn-schema";

/**
 * 반 수업 시간 — 저장은 칸 단위 `{weekday 1(월)~7(일), start, end}`(서버 `parseSchedule`),
 * 화면은 "같은 시간대의 요일 묶음" 여러 줄로 편집한다(월·수 16:00–17:00 / 금 18:00–19:30).
 * 막는 조건은 서버와 같게: 요일 1개 이상, 시작 < 끝, 똑같은 칸 금지, 풀어 놓은 칸 최대 14개.
 * 한 반 안의 칸끼리 겹치는 것은 경고만(저장 가능). 다른 반·강의실끼리는 검사하지 않는다(견적서 4-2).
 */

export const MAX_SCHEDULE_SLOTS = 14;
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

/** 편집 줄 → 칸(요일 × 시간대, 정렬). 똑같은 칸이 여러 줄에 있으면 그대로 둘 다 남긴다(검사가 막음) */
export function expandScheduleGroups(groups: readonly ScheduleGroup[]): AcademyClassScheduleSlot[] {
  return sortSlots(groups.flatMap((g) => g.weekdays.map((weekday) => ({ weekday, start: g.start, end: g.end }))));
}

/** 저장을 막는 오류(서버 `parseSchedule`과 같은 조건) — 없으면 null */
export function scheduleBlockingError(groups: readonly ScheduleGroup[]): string | null {
  for (const [i, g] of groups.entries()) {
    const label = groups.length > 1 ? `수업 시간 ${i + 1}: ` : "";
    if (g.weekdays.length === 0) return `${label}요일을 하나 이상 골라 주세요.`;
    if (!TIME_RE.test(g.start) || !TIME_RE.test(g.end)) return `${label}시작·끝 시간을 입력해 주세요.`;
    if (g.start >= g.end) return `${label}끝 시간은 시작 시간보다 늦어야 합니다.`;
  }
  const slots = expandScheduleGroups(groups);
  const seen = new Set<string>();
  for (const s of slots) {
    const k = `${s.weekday}|${s.start}|${s.end}`;
    if (seen.has(k)) {
      return `같은 수업 시간(${WEEKDAY_LABELS[s.weekday]} ${s.start}–${s.end})이 두 번 들어 있습니다.`;
    }
    seen.add(k);
  }
  if (slots.length > MAX_SCHEDULE_SLOTS) {
    return `수업 시간은 요일별로 최대 ${MAX_SCHEDULE_SLOTS}칸까지 등록할 수 있습니다(지금 ${slots.length}칸).`;
  }
  return null;
}

/** 한 반 안에서 같은 요일 칸끼리 시간이 겹치는지(경고만 — 똑같은 칸은 따로 막음) */
export function scheduleHasOverlap(slots: readonly AcademyClassScheduleSlot[]): boolean {
  const sorted = sortSlots(slots);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (a.weekday !== b.weekday) break;
      if (a.start === b.start && a.end === b.end) continue;
      if (b.start < a.end && a.start < b.end) return true;
    }
  }
  return false;
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
