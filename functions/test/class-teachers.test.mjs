/**
 * 반 담당 선생님 계산(`src/lib/class-teachers.ts`) 단위 테스트 — `npm test` (빌드 후 lib/ 대상)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classContributedTeacherUids,
  computeTeacherUids,
} from "../lib/lib/class-teachers.js";

describe("반 담당 선생님 → 학생 teacherUids", () => {
  const classes = new Map([
    ["a", { status: "active", teacherUids: ["t2", "t1"] }],
    ["b", { status: "preparing", teacherUids: ["t1", "t3"] }],
    ["ended", { status: "ended", teacherUids: ["t9"] }],
  ]);

  it("운영중·준비중 반 선생님의 합집합(중복 제거, 정렬)", () => {
    assert.deepEqual(computeTeacherUids(["a", "b"], classes), ["t1", "t2", "t3"]);
  });

  it("종강 반·없는(삭제된) 반은 빠진다", () => {
    assert.deepEqual(computeTeacherUids(["ended", "gone", "a"], classes), ["t1", "t2"]);
    assert.deepEqual(computeTeacherUids([], classes), []);
  });

  it("반이 주는 선생님 — 종강·삭제면 빈 목록(트리거가 바뀜 여부를 이것으로 판단)", () => {
    assert.deepEqual(classContributedTeacherUids({ status: "ended", teacherUids: ["t1"] }), []);
    assert.deepEqual(classContributedTeacherUids(undefined), []);
    assert.deepEqual(classContributedTeacherUids({ status: "active", teacherUids: ["t2", "t1", "t1", 3] }), ["t1", "t2"]);
  });
});
