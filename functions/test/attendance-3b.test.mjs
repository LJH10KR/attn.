/**
 * 3-B 판단 단위 테스트 — 지각 분·미리 채움, 하원(H2·H3·★5), 휴강(★11·P1), 알림 종류(★8), 다시 보내기(★10), 문구.
 * 결정 `docs/stage3-handoff/3-B-decisions.md`, 계획 `3-B-plan.md`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  arrivalCancelBlock,
  arrivalCorrectionCheck,
  arrivalTransition,
  classAttendanceBlock,
  CLASS_ATTENDANCE_BLOCK_LABELS,
  CLASS_ATTENDANCE_BLOCK_MESSAGES,
  classCancellationBlock,
  classCancellationBlockMessage,
  classCancelPushBody,
  classPushBody,
  classStatusOf,
  CLASS_STATUS_LABELS,
  departureBlock,
  departureCancelPushBody,
  departureLockPastMessage,
  departureLockTodayMessage,
  departurePushBody,
  isLateMinutes,
  lateLabel,
  LATE_MINUTES_MESSAGE,
  notifyTypeFor,
  readNotifySettings,
  RESEND_PREFIX,
  resendBody,
  resendStateMatches,
  seoulDateTimeMs,
  suggestLateMinutes,
  todayTimeBlock,
} from "../lib/lib/attendance-rules.js";
import { recentSeoulDates } from "../lib/attendance-history.js";

const at = new Date("2026-11-24T09:12:00Z"); // 서울 18:12

describe("지각 분(B1 ②)", () => {
  it("1~180 정수만", () => {
    for (const n of [1, 10, 180]) assert.equal(isLateMinutes(n), true);
    for (const n of [0, -5, 181, 12.5, "10", null, undefined, Number.NaN]) assert.equal(isLateMinutes(n), false);
    assert.equal(LATE_MINUTES_MESSAGE, "지각 시간은 1~180분으로 입력해 주세요.");
  });

  it("미리 채움 = 등원 − 수업 시작(내림), 시작 전·같은 분·시각 없음·180분 넘음은 null", () => {
    const date = "2026-11-24";
    const start = "15:00";
    const ms = (hhmm) => seoulDateTimeMs(date, hhmm);
    assert.equal(suggestLateMinutes(ms("15:12"), date, start), 12);
    assert.equal(suggestLateMinutes(ms("15:12") + 59_000, date, start), 12);
    assert.equal(suggestLateMinutes(ms("15:00") + 30_000, date, start), null);
    assert.equal(suggestLateMinutes(ms("14:50"), date, start), null);
    assert.equal(suggestLateMinutes(null, date, start), null);
    assert.equal(suggestLateMinutes(ms("15:12"), date, null), null);
    assert.equal(suggestLateMinutes(ms("18:00"), date, start), 180);
    assert.equal(suggestLateMinutes(ms("18:01"), date, start), null);
  });

  it("상태 매핑·라벨·칩", () => {
    assert.equal(classStatusOf("late"), "late");
    assert.equal(classStatusOf("absent"), "absent");
    assert.equal(classStatusOf("present"), "present");
    assert.equal(classStatusOf(undefined), "present");
    assert.equal(CLASS_STATUS_LABELS.late, "지각");
    assert.equal(lateLabel(12), "지각 12분");
    assert.equal(lateLabel(null), "지각");
  });

  it("알림 문구(⑤) — 지각은 분, 취소 문구", () => {
    assert.equal(
      classPushBody("김하늘", "A반", "late", [{ start: "15:00", end: "17:00" }], at, 10),
      "김하늘 학생이 A반 수업에 지각하였습니다(10분). (수업 시간 15:00~17:00 / 알림 전송 시각 18:12)",
    );
    assert.equal(
      classCancelPushBody("김하늘", "A반", "late", at),
      "김하늘 학생의 A반 수업 지각 기록이 취소되었습니다. (알림 전송 시각 18:12)",
    );
  });
});

describe("반 출결 조건 — 휴강(★12)", () => {
  const ok = { studentActive: true, isMember: true, classEnded: false, hasLessonToday: true, arrival: { status: "present", billed: false } };
  it("휴강이면 class_cancelled, 수업 없음보다 뒤·등원 전보다 앞", () => {
    assert.equal(classAttendanceBlock({ ...ok, classCancelled: true }), "class_cancelled");
    assert.equal(classAttendanceBlock({ ...ok, hasLessonToday: false, classCancelled: true }), "no_lesson_today");
    assert.equal(classAttendanceBlock({ ...ok, arrival: null, classCancelled: true }), "class_cancelled");
    assert.equal(classAttendanceBlock(ok), null);
    assert.equal(CLASS_ATTENDANCE_BLOCK_LABELS.class_cancelled, "휴강");
    assert.match(CLASS_ATTENDANCE_BLOCK_MESSAGES.class_cancelled, /휴강을 먼저 취소/);
  });
});

describe("하원 판단(H2·H3)", () => {
  it("등원 없음·미등원·이미 하원·가능", () => {
    assert.equal(departureBlock(null), "no_arrival");
    assert.equal(departureBlock({ status: "absent", billed: false }), "absent_day");
    assert.equal(departureBlock({ status: "absent", billed: true }), "absent_day");
    assert.equal(departureBlock({ status: "present", billed: false, departed: true }), "already_left");
    assert.equal(departureBlock({ status: "present", billed: false }), null);
    // 차감 잠금 날도 허용(H3)
    assert.equal(departureBlock({ status: "present", billed: true }), null);
  });

  it("★5 하원이 있으면 오늘 미등원 전환 거부 — 반 출결 검사 다음", () => {
    const left = { status: "present", billed: false, departed: true };
    assert.equal(arrivalTransition(left, "absent", 0), "has_departure");
    assert.equal(arrivalTransition(left, "absent", 2), "has_class_records");
    assert.equal(arrivalTransition(left, "present", 0), "unchanged");
  });

  it("★5 하원이 있으면 등원 취소 거부 — 반 출결 다음, 잠금 앞", () => {
    const base = { status: "present", reason: null, billed: false, classRecordCount: 0 };
    assert.equal(arrivalCancelBlock({ ...base, departed: true }), "has_departure");
    assert.equal(arrivalCancelBlock({ ...base, departed: true, classRecordCount: 1 }), "has_class_records");
    assert.equal(arrivalCancelBlock({ ...base, departed: false }), null);
  });

  it("★5 지난 날짜 미등원·지우기 거부, 시각만 바꾸기는 허용", () => {
    const prev = { status: "present", billed: false, reason: null, arrivedAtMs: 1000, departed: true };
    const to = (status, arrivedAtMs = null) => ({ status, reason: status === "absent" ? "general" : null, arrivedAtMs });
    assert.equal(arrivalCorrectionCheck(prev, to("absent"), 0), "has_departure");
    assert.equal(arrivalCorrectionCheck(prev, to(null), 0), "has_departure");
    assert.equal(arrivalCorrectionCheck(prev, to(null), 1), "has_class_records");
    assert.equal(arrivalCorrectionCheck(prev, to("present", 2000), 0), "ok");
  });

  it("문구", () => {
    assert.equal(departurePushBody("김하늘", at), "김하늘 학생이 하원하였습니다. (알림 전송 시각 18:12)");
    assert.equal(departureCancelPushBody("김하늘", at), "김하늘 학생의 하원 기록이 취소되었습니다. (알림 전송 시각 18:12)");
    assert.equal(departureLockTodayMessage(false), "하원 기록이 있어 미등원으로 바꿀 수 없습니다. 하원 기록을 먼저 취소해 주세요.");
    assert.equal(departureLockTodayMessage(true), "하원 기록이 있어 등원 기록을 취소할 수 없습니다. 하원 기록을 먼저 취소해 주세요.");
    assert.equal(
      departureLockPastMessage("2026-11-05", true),
      "11월 5일에는 하원 기록이 있어 등원 기록을 지울 수 없습니다. 하원 기록을 먼저 정정해 주세요.",
    );
  });
});

describe("휴강 판단(★11·P1)", () => {
  const today = "2026-11-24";
  const base = { today, classExists: true, classEnded: false, hasLesson: true, recordCount: 0 };
  it("오늘 = 종강 아님·그 요일 수업·출결 0건", () => {
    assert.equal(classCancellationBlock({ ...base, date: today }), null);
    assert.equal(classCancellationBlock({ ...base, date: today, classEnded: true }), "class_ended");
    assert.equal(classCancellationBlock({ ...base, date: today, hasLesson: false }), "no_lesson");
    assert.equal(classCancellationBlock({ ...base, date: today, recordCount: 2 }), "has_records");
  });
  it("지난 날짜 = 반 있음 + 출결 0건만(지금 종강·시간표 변경 반도 가능)", () => {
    const date = "2026-11-20";
    assert.equal(classCancellationBlock({ ...base, date, classEnded: true, hasLesson: false }), null);
    assert.equal(classCancellationBlock({ ...base, date, recordCount: 1 }), "has_records");
    assert.equal(classCancellationBlock({ ...base, date, classExists: false }), "class_missing");
  });
  it("미래는 거부, 문구", () => {
    assert.equal(classCancellationBlock({ ...base, date: "2026-11-25" }), "future");
    assert.equal(
      classCancellationBlockMessage("has_records", { date: "2026-11-20", className: "A반", recordCount: 3 }),
      "11월 20일 A반 수업 출결 기록이 3건 있어 휴강으로 기록할 수 없습니다. 출결을 먼저 정정해 주세요.",
    );
  });
});

describe("알림 종류(★8)", () => {
  it("맥락·상태·취소 → 종류", () => {
    assert.equal(notifyTypeFor({ context: "arrival", kind: "present" }), "arrival");
    assert.equal(notifyTypeFor({ context: "arrival", kind: "absent" }), "arrivalAbsent");
    assert.equal(notifyTypeFor({ context: "departure", kind: "left" }), "departure");
    assert.equal(notifyTypeFor({ context: "class", kind: "present" }), "classPresent");
    assert.equal(notifyTypeFor({ context: "class", kind: "late" }), "classLate");
    assert.equal(notifyTypeFor({ context: "class", kind: "absent" }), "classAbsent");
    for (const context of ["arrival", "class", "departure"]) {
      assert.equal(notifyTypeFor({ context, kind: "present", action: "cancel" }), "correction");
    }
  });
  it("설정 문서 — false만 끔, 없으면 모두 켬", () => {
    const all = readNotifySettings(undefined);
    assert.equal(Object.values(all).every(Boolean), true);
    assert.equal(Object.keys(all).length, 7);
    const s = readNotifySettings({ departure: false, classLate: "no", correction: true });
    assert.equal(s.departure, false);
    assert.equal(s.classLate, true);
    assert.equal(s.correction, true);
  });
});

describe("다시 보내기 — 지금 상태가 같은지(★10)", () => {
  const present = { status: "present", reason: null, departed: false };
  const left = { status: "present", reason: null, departed: true };
  const absentIll = { status: "absent", reason: "illness", departed: false };
  const now = (arrival, classStatus = null) => ({ arrival, classStatus });
  const item = (context, kind, action = "record", extra = {}) => ({ context, kind, action, ...extra });

  it("등원·미등원", () => {
    assert.equal(resendStateMatches(item("arrival", "present"), now(present)), true);
    assert.equal(resendStateMatches(item("arrival", "present"), now(absentIll)), false);
    assert.equal(resendStateMatches(item("arrival", "absent"), now(absentIll)), true);
    assert.equal(resendStateMatches(item("arrival", "absent"), now(null)), false);
    assert.equal(
      resendStateMatches(item("arrival", "absent", "record", { origin: "absence_period", reason: "illness" }), now(absentIll)),
      true,
    );
    assert.equal(
      resendStateMatches(item("arrival", "absent", "record", { origin: "absence_period", reason: "academy" }), now(absentIll)),
      false,
    );
  });
  it("하원·수업·취소", () => {
    assert.equal(resendStateMatches(item("departure", "left"), now(left)), true);
    assert.equal(resendStateMatches(item("departure", "left"), now(present)), false);
    assert.equal(resendStateMatches(item("departure", "left", "cancel"), now(present)), true);
    assert.equal(resendStateMatches(item("departure", "left", "cancel"), now(null)), false);
    assert.equal(resendStateMatches(item("class", "late"), now(present, "late")), true);
    assert.equal(resendStateMatches(item("class", "late"), now(present, "present")), false);
    assert.equal(resendStateMatches(item("class", "present", "cancel"), now(present, null)), true);
    assert.equal(resendStateMatches(item("class", "present", "cancel"), now(present, "present")), false);
    assert.equal(resendStateMatches(item("arrival", "present", "cancel"), now(null)), true);
    assert.equal(resendStateMatches(item("arrival", "present", "cancel"), now(present)), false);
  });

  it("앞 글자는 한 번만(R3 — 기간 결석 요약을 다시 보낸 것을 또 다시 보내도)", () => {
    const body = "민준 학생 결석 안내";
    assert.equal(resendBody(body), `${RESEND_PREFIX}${body}`);
    assert.equal(resendBody(resendBody(body)), `${RESEND_PREFIX}${body}`);
  });
});

describe("오늘 기록 시각 고치기(★7·R1)", () => {
  it("HH:mm 필수, 지금(서울 18:12)보다 늦으면 거부", () => {
    assert.equal(todayTimeBlock(undefined, at), "time_only");
    assert.equal(todayTimeBlock(null, at), "time_only");
    assert.equal(todayTimeBlock("9:00", at), "time_only");
    assert.equal(todayTimeBlock("18:12", at), null);
    assert.equal(todayTimeBlock("08:00", at), null);
    assert.equal(todayTimeBlock("18:13", at), "future");
    assert.equal(todayTimeBlock("23:50", at), "future");
  });
});

describe("학부모 출결 기록 날짜(★13)", () => {
  it("오늘 포함 31일, 오래된 날부터, 월 경계", () => {
    const d = recentSeoulDates("2026-03-02", 31);
    assert.equal(d.length, 31);
    assert.equal(d[30], "2026-03-02");
    assert.equal(d[0], "2026-01-31");
    assert.equal(new Set(d).size, 31);
  });
});
