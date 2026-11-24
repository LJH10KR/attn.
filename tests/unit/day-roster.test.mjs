/**
 * 3-A 원장 출결 화면 명단·요약(`src/lib/academy/day-roster.ts`) — `npm run test:unit`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDayRoster,
  ROSTER_FILTER_ALL,
  ROSTER_FILTER_NO_CLASS,
  rosterFilterOptions,
  summarizeDay,
} from "../../src/lib/academy/day-roster.ts";

const MON = 1;
const cls = (id, name, extra = {}) => ({ id, name, status: "active", sortOrder: 0, schedule: [], ...extra });
const stu = (id, name, classIds, status = "enrolled") => ({ id, name, gradeLabel: "중2", status, classIds });
const arrival = (status, extra = {}) => ({
  status, reason: status === "absent" ? "general" : null, note: null, arrivedAtMs: null,
  arrivedAtManual: false, billed: false, corrected: false, departed: false, leftAtMs: null, leftAtManual: false, ...extra,
});
const record = (classId, studentId, status, extra = {}) => ({
  classId, studentId, status, lateMinutes: null, className: `${classId}이름`, slots: [], reason: null, comment: null,
  corrected: false, hasSessionDeduction: false, ...extra,
});

const classes = [
  cls("math", "수학", { schedule: [{ weekday: MON, start: "16:00", end: "18:00" }], sortOrder: 2 }),
  cls("eng", "영어", { schedule: [{ weekday: MON, start: "14:00", end: "15:00" }], sortOrder: 1 }),
  cls("tue", "화요반", { schedule: [{ weekday: 2, start: "14:00", end: "15:00" }] }),
  cls("end", "끝난반", { status: "ended", schedule: [{ weekday: MON, start: "10:00", end: "11:00" }] }),
  cls("prep", "준비반", { status: "preparing", schedule: [{ weekday: MON, start: "19:00", end: "20:00" }] }),
];
const students = [
  stu("a", "가나", ["math", "eng"]),
  stu("b", "다라", ["math"]),
  stu("c", "마바", ["math"], "on_leave"),
  stu("d", "사아", ["tue"]),
  stu("e", "자차", []),
];

describe("buildDayRoster", () => {
  const roster = buildDayRoster({
    weekday: MON,
    classes,
    students,
    arrivals: new Map([
      ["a", arrival("present")],
      ["b", arrival("absent")],
      ["d", arrival("present")],
      ["e", arrival("present")],
    ]),
    records: [
      record("math", "a", "present"),
      record("math", "c", "absent"),
      record("tue", "d", "present"),
      record("end", "a", "present"),
      record("gone", "a", "absent", { className: "없어진반", slots: [{ start: "09:00", end: "10:00" }] }),
    ],
  });

  it("수업 반은 그 요일 시작 시각 순(종강 제외, 준비중 포함)", () => {
    const lesson = roster.sections.filter((s) => s.kind === "lesson").map((s) => s.classId);
    assert.deepEqual(lesson, ["eng", "math", "prep"]);
    assert.deepEqual(roster.sections.find((s) => s.classId === "eng").slots, [{ start: "14:00", end: "15:00" }]);
  });

  it("반 원생 = 현재 재원생 ∪ 그날 기록 있는 원생(휴원이어도 기록 있으면)", () => {
    const math = roster.sections.find((s) => s.classId === "math");
    assert.deepEqual(math.rows.map((r) => r.studentId), ["a", "b", "c"]);
    assert.equal(math.rows.find((r) => r.studentId === "c").studentStatus, "on_leave");
    assert.equal(math.rows.find((r) => r.studentId === "a").record.status, "present");
    assert.equal(math.rows.find((r) => r.studentId === "b").record, null);
  });

  it("기록만 남은 반 — 시간표 변경·종강·삭제(이름은 스냅샷)", () => {
    const left = roster.sections.filter((s) => s.kind === "leftover");
    const byId = Object.fromEntries(left.map((s) => [s.classId, s]));
    assert.equal(byId.tue.leftoverReason, "no_lesson");
    assert.equal(byId.end.leftoverReason, "ended");
    assert.equal(byId.gone.leftoverReason, "deleted");
    assert.equal(byId.gone.className, "없어진반");
    assert.deepEqual(byId.gone.slots, [{ start: "09:00", end: "10:00" }]);
    assert.deepEqual(byId.end.rows.map((r) => r.studentId), ["a"], "기록 있는 원생만");
  });

  it("수업 반 없이 등원 기록만 있는 원생", () => {
    assert.deepEqual(roster.noClass.map((n) => n.studentId), ["e"]);
  });

  it("요약 — 전체", () => {
    // 대상 a·b·c·d + noClass e: 등원 a·d·e, 미등원 b, 기록 없음 c
    // 줄: eng a(없음, 등원→미처리), math a 출석·b 없음(미등원)·c 결석, prep 없음, tue d 출석, end a 출석, gone a 결석
    assert.deepEqual(summarizeDay(roster, ROSTER_FILTER_ALL), {
      present: 3, absent: 1, departed: 0, noRecord: 1, classPresent: 3, classLate: 0, classAbsent: 2, unprocessed: 1,
    });
  });

  it("요약 — 반 하나·수업 반 없는 원생", () => {
    assert.deepEqual(summarizeDay(roster, "math"), {
      present: 1, absent: 1, departed: 0, noRecord: 1, classPresent: 1, classLate: 0, classAbsent: 1, unprocessed: 0,
    });
    assert.deepEqual(summarizeDay(roster, ROSTER_FILTER_NO_CLASS), {
      present: 1, absent: 0, departed: 0, noRecord: 0, classPresent: 0, classLate: 0, classAbsent: 0, unprocessed: 0,
    });
  });

  it("반 선택 목록", () => {
    const opts = rosterFilterOptions(roster).map((o) => o.value);
    assert.equal(opts[0], ROSTER_FILTER_ALL);
    assert.ok(opts.includes("gone"));
    assert.equal(opts.at(-1), ROSTER_FILTER_NO_CLASS);
  });

  it("빈 날", () => {
    const empty = buildDayRoster({ weekday: 7, classes, students, arrivals: new Map(), records: [] });
    assert.deepEqual(empty, { sections: [], noClass: [] });
  });
});

describe("3-B 하원·지각·휴강", () => {
  const cancel = (classId, className, extra = {}) => ({ classId, className, slots: [], memo: null, byName: "원장", ...extra });
  const roster = buildDayRoster({
    weekday: MON,
    classes,
    students: [...students, stu("f", "카타", ["eng"]), stu("g", "파하", ["prep"])],
    arrivals: new Map([
      ["a", arrival("present", { departed: true, leftAtMs: 1 })],
      ["b", arrival("absent")],
      ["f", arrival("present")],
    ]),
    records: [
      record("math", "a", "late", { lateMinutes: 12 }),
      record("eng", "f", "present"),
    ],
    cancellations: new Map([
      ["eng", cancel("eng", "영어")],
      // 수업 반이 아닌데 휴강만 있는 반(지난 날 휴강 뒤 종강 — P1)
      ["end", cancel("end", "끝난반", { slots: [{ start: "10:00", end: "11:00" }] })],
    ]),
  });

  it("휴강 표시 — 수업 반과 휴강만 있는 반(기록 없어도 보임)", () => {
    const byId = Object.fromEntries(roster.sections.map((s) => [s.classId, s]));
    assert.equal(byId.eng.cancellation.className, "영어");
    assert.equal(byId.math.cancellation, null);
    assert.equal(byId.end.kind, "leftover");
    assert.equal(byId.end.leftoverReason, "ended");
    assert.deepEqual(byId.end.rows, []);
    assert.deepEqual(byId.end.slots, [{ start: "10:00", end: "11:00" }]);
    assert.equal(rosterFilterOptions(roster).find((o) => o.value === "eng").label, "영어 (휴강)");
  });

  it("요약 4×2 — 하원·지각, 휴강 반은 수업 칸·미처리에서 빠지고 휴강 반에만 있는 기록 없음 원생은 세지 않음", () => {
    // 대상: eng(휴강) a·f, math a·b(c는 휴원·기록 없음이라 빠짐), prep g → 등원 a·f, 미등원 b, 하원 a, 기록 없음 g
    // 수업: math a 지각·b 없음(미등원), prep g 없음(등원 전) / eng 출석 f는 휴강이라 제외
    assert.deepEqual(summarizeDay(roster, ROSTER_FILTER_ALL), {
      present: 2, absent: 1, departed: 1, noRecord: 1, classPresent: 0, classLate: 1, classAbsent: 0, unprocessed: 0,
    });
    // 휴강 반에만 있는 원생이 기록이 없으면 "기록 없음"에 넣지 않는다
    const onlyCancelled = buildDayRoster({
      weekday: MON, classes, students: [stu("h", "하하", ["eng"])], arrivals: new Map(), records: [],
      cancellations: new Map([["eng", cancel("eng", "영어")]]),
    });
    assert.equal(summarizeDay(onlyCancelled, ROSTER_FILTER_ALL).noRecord, 0);
    assert.deepEqual(summarizeDay(roster, "eng"), {
      present: 2, absent: 0, departed: 1, noRecord: 0, classPresent: 0, classLate: 0, classAbsent: 0, unprocessed: 0,
    });
  });
});
