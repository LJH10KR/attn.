/**
 * 3-A 지난 날짜 정정 판단·문구·날짜 도우미 단위 테스트(`src/lib/attendance-rules.ts` 3-A 절).
 * 두 attendance-rules.ts 비교는 `attendance-cancel.test.mjs`에 있다.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  arrivalCorrectionCheck,
  arrivalCorrectionClassRecordsMessage,
  ATTENDANCE_BATCH_MAX,
  BATCH_MODE_MISMATCH_MESSAGE,
  classCorrectionBlock,
  classCorrectionBlockMessage,
  CORRECTION_DATE_MESSAGES,
  CORRECTION_PERMISSION_MESSAGE,
  correctionDateBlock,
  dateLabel,
  isHHmm,
  isValidDateString,
  REASON_NOT_ABSENT_MESSAGE,
  reasonForStatus,
  RECORD_NOT_TODAY_MESSAGE,
  seoulDateTimeMs,
  SESSION_DEDUCTION_LOCKED_MESSAGE,
  weekdayOfDate,
} from "../lib/lib/attendance-rules.js";

describe("날짜·시각 도우미", () => {
  it("isValidDateString — 형식과 실제 날짜", () => {
    assert.equal(isValidDateString("2026-11-12"), true);
    assert.equal(isValidDateString("2026-02-29"), false);
    assert.equal(isValidDateString("2024-02-29"), true);
    assert.equal(isValidDateString("2026-1-12"), false);
    assert.equal(isValidDateString(20261112), false);
  });
  it("weekdayOfDate — 서울 요일(월=1~일=7)", () => {
    assert.equal(weekdayOfDate("2026-11-09"), 1);
    assert.equal(weekdayOfDate("2026-11-13"), 5);
    assert.equal(weekdayOfDate("2026-11-15"), 7);
  });
  it("dateLabel", () => {
    assert.equal(dateLabel("2026-11-05"), "11월 5일");
  });
  it("isHHmm — 00:00~23:59만", () => {
    for (const ok of ["00:00", "09:05", "23:59"]) assert.equal(isHHmm(ok), true, ok);
    for (const bad of ["24:00", "9:05", "12:60", "", null, 1230]) assert.equal(isHHmm(bad), false, String(bad));
  });
  it("seoulDateTimeMs — 서울 시각", () => {
    assert.equal(new Date(seoulDateTimeMs("2026-11-12", "14:30")).toISOString(), "2026-11-12T05:30:00.000Z");
    assert.equal(new Date(seoulDateTimeMs("2026-11-12", "00:10")).toISOString(), "2026-11-11T15:10:00.000Z");
  });
  it("correctionDateBlock — 오늘·미래 거부", () => {
    assert.equal(correctionDateBlock("2026-11-12", "2026-11-13"), null);
    assert.equal(correctionDateBlock("2020-01-01", "2026-11-13"), null);
    assert.equal(correctionDateBlock("2026-11-13", "2026-11-13"), "today");
    assert.equal(correctionDateBlock("2026-11-14", "2026-11-13"), "future");
  });
});

describe("사유 전환(★3)", () => {
  it("등원·출석이면 사유 없음", () => {
    assert.equal(reasonForStatus("present", "illness"), null);
  });
  it("미등원·결석이면 이전 사유, 없거나 잘못된 값이면 기타", () => {
    assert.equal(reasonForStatus("absent", "illness"), "illness");
    assert.equal(reasonForStatus("absent", "academy"), "academy");
    assert.equal(reasonForStatus("absent", null), "general");
    assert.equal(reasonForStatus("absent", "weird"), "general");
  });
});

describe("등원 기록 정정 판단 — 같은 내용 → 차감 잠금 → 반 출결", () => {
  const present = { status: "present", billed: false, reason: null, arrivedAtMs: 1000 };
  const absent = { status: "absent", billed: false, reason: "general", arrivedAtMs: null };
  const to = (status, extra = {}) => ({ status, reason: status === "absent" ? "general" : null, arrivedAtMs: null, ...extra });

  it("없음 → 지우기, 같은 상태·같은 시각/사유는 unchanged", () => {
    assert.equal(arrivalCorrectionCheck(null, to(null), 0), "unchanged");
    assert.equal(arrivalCorrectionCheck(present, to("present", { arrivedAtMs: 1000 }), 0), "unchanged");
    assert.equal(arrivalCorrectionCheck(absent, to("absent"), 3), "unchanged");
  });
  it("B4 — 같은 등원인데 시각만 다르면 ok", () => {
    assert.equal(arrivalCorrectionCheck(present, to("present", { arrivedAtMs: 2000 }), 2), "ok");
    assert.equal(arrivalCorrectionCheck(present, to("present", { arrivedAtMs: null }), 0), "ok");
  });
  it("같은 미등원인데 사유만 다르면 ok", () => {
    assert.equal(arrivalCorrectionCheck(absent, to("absent", { reason: "illness" }), 0), "ok");
  });
  it("차감 잠금은 상태·사유·시각 변경과 삭제 모두 거부(같은 내용이면 unchanged 먼저)", () => {
    const billed = { ...absent, billed: true };
    assert.equal(arrivalCorrectionCheck(billed, to("absent"), 0), "unchanged");
    assert.equal(arrivalCorrectionCheck(billed, to("absent", { reason: "illness" }), 0), "billed");
    assert.equal(arrivalCorrectionCheck(billed, to("present"), 0), "billed");
    assert.equal(arrivalCorrectionCheck(billed, to(null), 0), "billed");
  });
  it("반 출결이 있으면 등원 → 미등원·삭제 거부, 등원 시각 변경·미등원 사유 변경은 허용", () => {
    assert.equal(arrivalCorrectionCheck(present, to("absent"), 1), "has_class_records");
    assert.equal(arrivalCorrectionCheck(present, to(null), 2), "has_class_records");
    assert.equal(arrivalCorrectionCheck(present, to("absent"), 0), "ok");
    assert.equal(arrivalCorrectionCheck(null, to("absent"), 0), "ok");
    assert.equal(arrivalCorrectionCheck(null, to("present"), 0), "ok");
  });
  it("문구", () => {
    assert.equal(
      arrivalCorrectionClassRecordsMessage("2026-11-05", 2, false),
      "11월 5일에는 수업 출결 기록이 2건 있어 미등원으로 바꿀 수 없습니다. 수업 출결을 먼저 정정해 주세요.",
    );
    assert.equal(
      arrivalCorrectionClassRecordsMessage("2026-11-05", 1, true),
      "11월 5일에는 수업 출결 기록이 1건 있어 등원 기록을 지울 수 없습니다. 수업 출결을 먼저 정정해 주세요.",
    );
  });
});

describe("반 출결 정정 판단 — 회차 차감 → 지우기 → 반 원생 → 등원", () => {
  const base = {
    next: "present",
    recordExists: false,
    hasSessionDeduction: false,
    isMember: true,
    arrival: { status: "present", billed: false },
  };
  it("반 원생이고 등원이면 통과", () => {
    assert.equal(classCorrectionBlock(base), null);
    assert.equal(classCorrectionBlock({ ...base, next: "absent" }), null);
  });
  it("회차 차감이 연결된 기록은 지우기 포함 거부", () => {
    assert.equal(classCorrectionBlock({ ...base, recordExists: true, hasSessionDeduction: true, next: null }), "session_deduction");
  });
  it("지우기는 등원 상태·반 원생과 상관없이 통과", () => {
    assert.equal(classCorrectionBlock({ ...base, next: null, recordExists: true, isMember: false, arrival: null }), null);
  });
  it("반 원생이 아니면 새 기록 거부, 그날 기록이 있으면 바꾸기 허용", () => {
    assert.equal(classCorrectionBlock({ ...base, isMember: false }), "not_member");
    assert.equal(classCorrectionBlock({ ...base, isMember: false, recordExists: true }), null);
  });
  it("등원 기록 없음·미등원(잠금 여부 무관) 거부", () => {
    assert.equal(classCorrectionBlock({ ...base, arrival: null }), "not_arrived");
    assert.equal(classCorrectionBlock({ ...base, arrival: { status: "absent", billed: false } }), "absent_day");
    assert.equal(classCorrectionBlock({ ...base, arrival: { status: "absent", billed: true } }), "absent_day");
  });
  it("재원·종강·그날 수업은 보지 않음(입력에 없음)", () => {
    assert.deepEqual(Object.keys(base).sort(), ["arrival", "hasSessionDeduction", "isMember", "next", "recordExists"]);
  });
  it("문구", () => {
    assert.equal(classCorrectionBlockMessage("session_deduction", "2026-11-05"), SESSION_DEDUCTION_LOCKED_MESSAGE);
    assert.equal(
      classCorrectionBlockMessage("not_member", "2026-11-05"),
      "이 반 원생이 아니어서 11월 5일 수업 출결을 새로 기록할 수 없습니다.",
    );
    assert.equal(
      classCorrectionBlockMessage("not_arrived", "2026-11-05"),
      "11월 5일 등원 기록이 없어 수업 출결을 기록할 수 없습니다. 등원 기록을 먼저 정정해 주세요.",
    );
    assert.equal(
      classCorrectionBlockMessage("absent_day", "2026-11-05"),
      "11월 5일은 미등원으로 기록되어 있어 수업 출결을 기록할 수 없습니다. 등원 기록을 먼저 정정해 주세요.",
    );
  });
});

describe("고정 문구", () => {
  it("정정·기록 날짜·권한·사유·일괄", () => {
    assert.equal(CORRECTION_DATE_MESSAGES.today, "지난 날짜만 정정할 수 있습니다. 오늘 기록은 출결 버튼으로 처리해 주세요.");
    assert.equal(CORRECTION_DATE_MESSAGES.future, "앞으로의 날짜는 정정할 수 없습니다.");
    assert.equal(CORRECTION_PERMISSION_MESSAGE, "지난 날짜 출결은 원장이나 출결 권한이 있는 직원만 정정할 수 있습니다.");
    assert.equal(RECORD_NOT_TODAY_MESSAGE, "오늘 기록만 처리할 수 있습니다. 화면을 새로고침해 주세요.");
    assert.equal(REASON_NOT_ABSENT_MESSAGE, "사유는 미등원·결석 기록에만 고를 수 있습니다.");
    assert.equal(SESSION_DEDUCTION_LOCKED_MESSAGE, "회차 차감이 연결된 기록이라 정정할 수 없습니다.");
    assert.equal(ATTENDANCE_BATCH_MAX, 50);
    assert.match(BATCH_MODE_MISMATCH_MESSAGE, /새로고침/);
  });
});
