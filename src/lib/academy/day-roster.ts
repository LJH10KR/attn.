/**
 * 3-A 원장 출결 화면 — 그날 명단·요약 숫자(순수 함수, `npm run test:unit`).
 * 결정 `docs/stage3-handoff/3-A-start.md` A1·A2, 계획 `3-A-plan.md` 2장(★13 미처리 정의).
 * Node 타입 제거로 바로 불러오므로 값 import 없이 이 파일 안에서 끝낸다(타입만 import).
 *
 * 반 묶음(순서):
 *  ① lesson   — 그 요일 수업이 있는 운영 반(종강 제외, 현재 시간표 기준)
 *  ② leftover — 그날 반 출결 기록만 남은 반(종강·시간표 변경·삭제된 반, ★8 carryover)
 *  그리고 수업 반 없이 등원 기록만 있는 원생(noClass).
 * 반 원생 = 현재 그 반 재원생 ∪ 그날 그 반 기록이 있는 원생.
 */

export type RosterSlot = { start: string; end: string };

export type RosterClass = {
  id: string;
  name: string;
  status: "preparing" | "active" | "ended";
  sortOrder: number;
  schedule: readonly { weekday: number; start: string; end: string }[];
};

export type RosterStudent = {
  id: string;
  name: string;
  gradeLabel: string;
  status: "enrolled" | "prospect" | "on_leave" | "withdrawn";
  classIds: readonly string[];
};

/** 그날 등원 기록(문서가 없으면 Map에 없음) */
export type DayArrival = {
  status: "present" | "absent";
  reason: string | null;
  note: string | null;
  arrivedAtMs: number | null;
  arrivedAtManual: boolean;
  billed: boolean;
  corrected: boolean;
};

/** 그날 반 출결 한 건 */
export type DayClassRecord = {
  classId: string;
  studentId: string;
  status: "present" | "absent";
  className: string;
  slots: RosterSlot[];
  reason: string | null;
  comment: string | null;
  corrected: boolean;
  hasSessionDeduction: boolean;
};

export type RosterRow = {
  studentId: string;
  name: string;
  gradeLabel: string;
  /** null = 학생 문서 없음(지워진 원생의 남은 기록) */
  studentStatus: RosterStudent["status"] | null;
  /** 현재 그 반 원생 */
  isMember: boolean;
  arrival: DayArrival | null;
  record: DayClassRecord | null;
};

export type LeftoverReason = "ended" | "no_lesson" | "deleted";

export type RosterSection = {
  kind: "lesson" | "leftover";
  classId: string;
  className: string;
  cls: RosterClass | null;
  /** lesson = 그 요일 현재 시간표, leftover = 기록의 시간 스냅샷(첫 기록) */
  slots: RosterSlot[];
  leftoverReason: LeftoverReason | null;
  rows: RosterRow[];
};

export type NoClassRow = { studentId: string; name: string; gradeLabel: string; arrival: DayArrival };

export type DayRoster = { sections: RosterSection[]; noClass: NoClassRow[] };

/** 반 선택 ▾ 값 — 전체, 반 id, 수업 반 없는 원생 */
export const ROSTER_FILTER_ALL = "__all";
export const ROSTER_FILTER_NO_CLASS = "__noclass";

function slotsOn(schedule: RosterClass["schedule"], weekday: number): RosterSlot[] {
  return schedule
    .filter((s) => s.weekday === weekday)
    .map((s) => ({ start: s.start, end: s.end }))
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, "ko");
}

export function buildDayRoster(params: {
  /** 그 날짜의 서울 요일(월=1 ~ 일=7) */
  weekday: number;
  classes: readonly RosterClass[];
  students: readonly RosterStudent[];
  arrivals: ReadonlyMap<string, DayArrival>;
  records: readonly DayClassRecord[];
}): DayRoster {
  const { weekday, classes, students, arrivals, records } = params;
  const studentById = new Map(students.map((s) => [s.id, s]));
  const classById = new Map(classes.map((c) => [c.id, c]));
  const recordsByClass = new Map<string, DayClassRecord[]>();
  for (const r of records) {
    const list = recordsByClass.get(r.classId) ?? [];
    list.push(r);
    recordsByClass.set(r.classId, list);
  }

  const rowFor = (studentId: string, classId: string, record: DayClassRecord | null): RosterRow => {
    const s = studentById.get(studentId) ?? null;
    return {
      studentId,
      name: s?.name || (s ? "(이름 없음)" : "(삭제된 원생)"),
      gradeLabel: s?.gradeLabel ?? "",
      studentStatus: s?.status ?? null,
      isMember: Boolean(s?.classIds.includes(classId)),
      arrival: arrivals.get(studentId) ?? null,
      record,
    };
  };

  const rowsFor = (classId: string, includeMembers: boolean): RosterRow[] => {
    const recs = recordsByClass.get(classId) ?? [];
    const recByStudent = new Map(recs.map((r) => [r.studentId, r]));
    const ids = new Set<string>(recs.map((r) => r.studentId));
    if (includeMembers) {
      for (const s of students) if (s.status === "enrolled" && s.classIds.includes(classId)) ids.add(s.id);
    }
    return [...ids].map((id) => rowFor(id, classId, recByStudent.get(id) ?? null)).sort(byName);
  };

  const lesson = classes
    .filter((c) => c.status !== "ended")
    .map((c) => ({ c, slots: slotsOn(c.schedule, weekday) }))
    .filter((x) => x.slots.length > 0)
    .sort((a, b) => a.slots[0]!.start.localeCompare(b.slots[0]!.start) || a.c.sortOrder - b.c.sortOrder);
  const lessonIds = new Set(lesson.map((x) => x.c.id));

  const sections: RosterSection[] = lesson.map(({ c, slots }) => ({
    kind: "lesson",
    classId: c.id,
    className: c.name || "(이름 없음)",
    cls: c,
    slots,
    leftoverReason: null,
    rows: rowsFor(c.id, true),
  }));

  const leftover: RosterSection[] = [...recordsByClass.keys()]
    .filter((id) => !lessonIds.has(id))
    .map((id) => {
      const c = classById.get(id) ?? null;
      const first = recordsByClass.get(id)![0]!;
      return {
        kind: "leftover" as const,
        classId: id,
        className: c?.name || first.className || "반",
        cls: c,
        slots: first.slots,
        leftoverReason: (!c ? "deleted" : c.status === "ended" ? "ended" : "no_lesson") as LeftoverReason,
        rows: rowsFor(id, false),
      };
    })
    .sort((a, b) => a.className.localeCompare(b.className, "ko"));
  sections.push(...leftover);

  const inSections = new Set(sections.flatMap((s) => s.rows.map((r) => r.studentId)));
  const noClass: NoClassRow[] = [...arrivals.entries()]
    .filter(([id]) => !inSections.has(id))
    .map(([id, arrival]) => {
      const s = studentById.get(id);
      return { studentId: id, name: s?.name || "(삭제된 원생)", gradeLabel: s?.gradeLabel ?? "", arrival };
    })
    .sort(byName);

  return { sections, noClass };
}

export type DaySummary = {
  /** 등원 기록 — 대상 원생 기준 */
  present: number;
  absent: number;
  noRecord: number;
  /** 반 출결 — 반 × 원생 줄 기준 */
  classPresent: number;
  classAbsent: number;
  /** 등원했는데 그 반 출결이 없는 줄(★13) */
  unprocessed: number;
};

/** 고른 반(또는 전체·수업 반 없는 원생) 기준 요약 숫자 */
export function summarizeDay(roster: DayRoster, filter: string): DaySummary {
  const sections =
    filter === ROSTER_FILTER_ALL
      ? roster.sections
      : filter === ROSTER_FILTER_NO_CLASS
        ? []
        : roster.sections.filter((s) => s.classId === filter);
  const noClass = filter === ROSTER_FILTER_ALL || filter === ROSTER_FILTER_NO_CLASS ? roster.noClass : [];

  const arrivalByStudent = new Map<string, DayArrival | null>();
  for (const s of sections) for (const r of s.rows) arrivalByStudent.set(r.studentId, r.arrival);
  for (const n of noClass) arrivalByStudent.set(n.studentId, n.arrival);

  const out: DaySummary = { present: 0, absent: 0, noRecord: 0, classPresent: 0, classAbsent: 0, unprocessed: 0 };
  for (const a of arrivalByStudent.values()) {
    if (!a) out.noRecord += 1;
    else if (a.status === "present") out.present += 1;
    else out.absent += 1;
  }
  for (const s of sections) {
    for (const r of s.rows) {
      if (r.record?.status === "present") out.classPresent += 1;
      else if (r.record?.status === "absent") out.classAbsent += 1;
      else if (r.arrival?.status === "present") out.unprocessed += 1;
    }
  }
  return out;
}

/** 반 선택 ▾ 목록 — 그날 보이는 반 + 수업 반 없는 원생(있을 때) */
export function rosterFilterOptions(roster: DayRoster): { value: string; label: string }[] {
  const opts = [{ value: ROSTER_FILTER_ALL, label: "전체 반" }];
  for (const s of roster.sections) {
    opts.push({ value: s.classId, label: s.kind === "leftover" ? `${s.className} (기록만)` : s.className });
  }
  if (roster.noClass.length > 0) opts.push({ value: ROSTER_FILTER_NO_CLASS, label: "수업 반 없는 원생" });
  return opts;
}
