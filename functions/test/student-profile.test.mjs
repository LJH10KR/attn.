/**
 * 원생 상태·학년 판단(`src/lib/student-profile.ts`) 단위 테스트 — `npm test` (빌드 후 lib/ 대상)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  displayGrade,
  gradeLabel,
  isActiveStudent,
  isBillableStudent,
  kstYear,
  normalizeStudentStatus,
} from "../lib/lib/student-profile.js";

describe("학년 진급", () => {
  it("저장한 해에는 그대로, 해가 바뀌면 한 칸씩 올라간다", () => {
    assert.equal(displayGrade("e3", 2026, 2026), "e3");
    assert.equal(displayGrade("e3", 2026, 2027), "e4");
    assert.equal(displayGrade("e6", 2026, 2027), "m1");
    assert.equal(displayGrade("m3", 2026, 2027), "h1");
  });

  it("고3 다음은 졸업", () => {
    assert.equal(displayGrade("h3", 2026, 2027), "graduated");
    assert.equal(displayGrade("h1", 2020, 2030), "graduated");
    assert.equal(gradeLabel("graduated"), "졸업");
  });

  it("미취학·성인·기타는 자동 진급하지 않는다", () => {
    assert.equal(displayGrade("preschool", 2020, 2030), "preschool");
    assert.equal(displayGrade("adult", 2020, 2030), "adult");
  });

  it("기준 연도가 미래(시계 오류)면 저장 학년 그대로, 모르는 코드는 null", () => {
    assert.equal(displayGrade("e3", 2030, 2026), "e3");
    assert.equal(displayGrade("x9", 2026, 2026), null);
    assert.equal(gradeLabel(null), "");
  });

  it("서울 기준 1월 1일에 해가 바뀐다", () => {
    // UTC 12-31 15:00 = 서울 1-1 00:00
    assert.equal(kstYear(new Date("2026-12-31T14:59:59Z")), 2026);
    assert.equal(kstYear(new Date("2026-12-31T15:00:00Z")), 2027);
  });
});

describe("원생 상태", () => {
  it("값이 없거나 모르는 값은 재원", () => {
    assert.equal(normalizeStudentStatus(undefined), "enrolled");
    assert.equal(normalizeStudentStatus("weird"), "enrolled");
    assert.equal(normalizeStudentStatus("on_leave"), "on_leave");
  });

  it("재원만 알림·청구 대상", () => {
    assert.equal(isActiveStudent({ status: "enrolled" }), true);
    assert.equal(isBillableStudent({}), true);
    for (const status of ["prospect", "withdrawn", "on_leave"]) {
      assert.equal(isActiveStudent({ status }), false);
      assert.equal(isBillableStudent({ status }), false);
    }
  });
});
