/**
 * 2-I 등원·반 출결 판단(`src/lib/attendance-rules.ts`)·수업 시간(`src/lib/class-schedule.ts`) 단위 테스트
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  arrivalPushBody,
  arrivalTransition,
  classAttendanceBlock,
  classPushBody,
  CLASS_ATTENDANCE_BLOCK_LABELS,
  CLASS_ATTENDANCE_BLOCK_MESSAGES,
  CLASS_ATTENDANCE_BLOCKS,
  formatSeoulHHmm,
  seoulDateString,
  seoulWeekday,
  slotsLabel,
  slotsOnWeekday,
} from "../lib/lib/attendance-rules.js";
import { parseSchedule, DUPLICATE_WEEKDAY_MESSAGE } from "../lib/lib/class-schedule.js";

const ok = { studentActive: true, isMember: true, classEnded: false, hasLessonToday: true };
const present = { status: "present", billed: false };

describe("반 출결 조건 — 검사 순서대로 첫 이유", () => {
  it("모두 맞으면 null", () => {
    assert.equal(classAttendanceBlock({ ...ok, arrival: present }), null);
  });
  it("재원 아님이 가장 먼저", () => {
    assert.equal(
      classAttendanceBlock({ studentActive: false, isMember: false, classEnded: true, hasLessonToday: false, arrival: null }),
      "inactive_student",
    );
  });
  it("반 원생 아님 → 종강 → 오늘 수업 없음 → 등원 전", () => {
    assert.equal(classAttendanceBlock({ ...ok, isMember: false, arrival: present }), "not_member");
    assert.equal(classAttendanceBlock({ ...ok, classEnded: true, hasLessonToday: false, arrival: present }), "class_ended");
    assert.equal(classAttendanceBlock({ ...ok, hasLessonToday: false, arrival: null }), "no_lesson_today");
    assert.equal(classAttendanceBlock({ ...ok, arrival: null }), "not_arrived");
  });
  it("미등원은 차감 잠금이면 '차감 반영일', 아니면 '미등원'", () => {
    assert.equal(classAttendanceBlock({ ...ok, arrival: { status: "absent", billed: true } }), "billed_absent");
    assert.equal(classAttendanceBlock({ ...ok, arrival: { status: "absent", billed: false } }), "absent_today");
  });
  it("모든 이유에 화면 이름·서버 문구가 있다", () => {
    for (const b of CLASS_ATTENDANCE_BLOCKS) {
      assert.ok(CLASS_ATTENDANCE_BLOCK_LABELS[b]);
      assert.ok(CLASS_ATTENDANCE_BLOCK_MESSAGES[b]);
    }
    assert.equal(CLASS_ATTENDANCE_BLOCK_LABELS.billed_absent, "차감 반영일");
    assert.equal(
      CLASS_ATTENDANCE_BLOCK_MESSAGES.billed_absent,
      "청구서 결석 차감에 반영된 날입니다. 청구서에서 차감을 삭제한 뒤 등원 처리해 주세요.",
    );
  });
});

describe("등원 기록 전환", () => {
  it("기록 없음 → 등원·미등원 허용", () => {
    assert.equal(arrivalTransition(null, "present", 0), "ok");
    assert.equal(arrivalTransition(null, "absent", 0), "ok");
  });
  it("미등원 → 등원(늦게 온 경우) 허용", () => {
    assert.equal(arrivalTransition({ status: "absent", billed: false }, "present", 0), "ok");
  });
  it("등원 → 미등원은 그날 반 출결 0건일 때만", () => {
    assert.equal(arrivalTransition(present, "absent", 0), "ok");
    assert.equal(arrivalTransition(present, "absent", 2), "has_class_records");
  });
  it("같은 상태는 unchanged(차감 잠금이어도)", () => {
    assert.equal(arrivalTransition(present, "present", 0), "unchanged");
    assert.equal(arrivalTransition({ status: "absent", billed: true }, "absent", 0), "unchanged");
  });
  it("차감 잠금 날짜는 바꾸지 않음", () => {
    assert.equal(arrivalTransition({ status: "absent", billed: true }, "present", 0), "billed");
  });
});

describe("서울 시각·날짜·요일", () => {
  it("HH:mm 24시간, 자정은 00", () => {
    assert.equal(formatSeoulHHmm(new Date("2026-11-04T06:02:00Z")), "15:02");
    assert.equal(formatSeoulHHmm(new Date("2026-11-04T15:05:00Z")), "00:05");
    assert.equal(formatSeoulHHmm(new Date("2026-11-04T00:00:00Z")), "09:00");
  });
  it("UTC 15시 이후는 서울 다음 날·다음 요일", () => {
    // 2026-11-04(수) UTC 15:30 = 서울 11-05(목) 00:30
    assert.equal(seoulDateString(new Date("2026-11-04T15:30:00Z")), "2026-11-05");
    assert.equal(seoulWeekday(new Date("2026-11-04T15:30:00Z")), 4);
    assert.equal(seoulWeekday(new Date("2026-11-08T03:00:00Z")), 7);
  });
});

describe("알림 문구(결정 4장 그대로)", () => {
  const at = new Date("2026-11-04T06:02:00Z");
  it("등원·미등원", () => {
    assert.equal(arrivalPushBody("김하늘", "present", at), "김하늘 학생이 안전하게 등원하였습니다. (알림 전송 시각 15:02)");
    assert.equal(arrivalPushBody("김하늘", "absent", at), "김하늘 학생이 아직 등원하지 않았습니다. (알림 전송 시각 15:02)");
  });
  it("반 출석·결석", () => {
    const slots = [{ start: "15:00", end: "17:00" }];
    assert.equal(
      classPushBody("김하늘", "A반", "present", slots, at),
      "김하늘 학생이 A반 수업에 출석하였습니다. (수업 시간 15:00~17:00 / 알림 전송 시각 15:02)",
    );
    assert.equal(
      classPushBody("김하늘", "A반", "absent", slots, at),
      "김하늘 학생이 A반 수업에 결석하였습니다. (수업 시간 15:00~17:00 / 알림 전송 시각 15:02)",
    );
  });
  it("예전 중복 데이터로 그날 여러 칸이면 모두 적는다(시작 순)", () => {
    const schedule = [
      { weekday: 3, start: "18:00", end: "19:00" },
      { weekday: 3, start: "15:00", end: "16:00" },
      { weekday: 1, start: "10:00", end: "11:00" },
    ];
    assert.equal(slotsLabel(slotsOnWeekday(schedule, 3)), "15:00~16:00, 18:00~19:00");
  });
});

describe("parseSchedule — 요일당 1칸, 최대 7칸", () => {
  it("같은 시간 다른 요일은 허용, 요일 순 정렬", () => {
    assert.deepEqual(
      parseSchedule([
        { weekday: 3, start: "16:00", end: "17:00" },
        { weekday: 1, start: "16:00", end: "17:00" },
      ]),
      [
        { weekday: 1, start: "16:00", end: "17:00" },
        { weekday: 3, start: "16:00", end: "17:00" },
      ],
    );
  });
  it("같은 요일 두 칸은 시간이 달라도 거부", () => {
    assert.throws(
      () =>
        parseSchedule([
          { weekday: 1, start: "15:00", end: "16:00" },
          { weekday: 1, start: "18:00", end: "19:00" },
        ]),
      (e) => e.message === DUPLICATE_WEEKDAY_MESSAGE,
    );
  });
  it("8칸은 거부, 7칸(월~일)은 허용", () => {
    const week = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: "09:00", end: "10:00" }));
    assert.equal(parseSchedule(week).length, 7);
    assert.throws(() => parseSchedule([...week, { weekday: 1, start: "11:00", end: "12:00" }]));
  });
  it("시작 ≥ 끝, 형식 오류는 거부, 빈 값은 []", () => {
    assert.throws(() => parseSchedule([{ weekday: 1, start: "17:00", end: "16:00" }]));
    assert.throws(() => parseSchedule([{ weekday: 8, start: "16:00", end: "17:00" }]));
    assert.deepEqual(parseSchedule(undefined), []);
  });
});
