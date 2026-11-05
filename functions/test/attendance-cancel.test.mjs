/**
 * 2-J 출결 취소 판단·취소 알림 문구 단위 테스트(`src/lib/attendance-rules.ts`),
 * 두 attendance-rules.ts(functions ↔ 화면)가 머리 주석의 상대 파일 경로 줄만 빼고 같은지.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARRIVAL_CANCEL_REASON_LOCKED_MESSAGE,
  arrivalCancelBlock,
  arrivalCancelClassRecordsMessage,
  arrivalCancelPushBody,
  CANCEL_NOT_TODAY_MESSAGE,
  classCancelPushBody,
} from "../lib/lib/attendance-rules.js";

// 2026-11-05 15:05 서울 = 06:05 UTC
const at = new Date("2026-11-05T06:05:00Z");
// 자정 직후 00:07 서울
const midnight = new Date("2026-11-04T15:07:00Z");

describe("취소 알림 문구(2-J J2)", () => {
  it("반 출석·결석 취소", () => {
    assert.equal(
      classCancelPushBody("김하나", "A반", "present", at),
      "김하나 학생의 A반 수업 출석 기록이 취소되었습니다. (알림 전송 시각 15:05)",
    );
    assert.equal(
      classCancelPushBody("김하나", "A반", "absent", at),
      "김하나 학생의 A반 수업 결석 기록이 취소되었습니다. (알림 전송 시각 15:05)",
    );
  });
  it("등원·미등원 취소", () => {
    assert.equal(
      arrivalCancelPushBody("김하나", "present", at),
      "김하나 학생의 등원 기록이 취소되었습니다. (알림 전송 시각 15:05)",
    );
    assert.equal(
      arrivalCancelPushBody("김하나", "absent", at),
      "김하나 학생의 미등원 기록이 취소되었습니다. (알림 전송 시각 15:05)",
    );
  });
  it("자정 직후는 00:xx", () => {
    assert.match(arrivalCancelPushBody("가", "present", midnight), /\(알림 전송 시각 00:07\)$/);
    assert.match(classCancelPushBody("가", "B반", "absent", midnight), /\(알림 전송 시각 00:07\)$/);
  });
});

describe("등원 취소 판단 — 반 출결 → 차감 잠금 → 사유 순서", () => {
  const base = { status: "present", reason: null, billed: false, classRecordCount: 0 };
  it("등원은 취소 가능", () => {
    assert.equal(arrivalCancelBlock(base), null);
  });
  it("기타·사유 없는 미등원은 취소 가능", () => {
    assert.equal(arrivalCancelBlock({ ...base, status: "absent", reason: "general" }), null);
    assert.equal(arrivalCancelBlock({ ...base, status: "absent", reason: null }), null);
  });
  it("질병·학원 사정 미등원은 거부", () => {
    assert.equal(arrivalCancelBlock({ ...base, status: "absent", reason: "illness" }), "reason_locked");
    assert.equal(arrivalCancelBlock({ ...base, status: "absent", reason: "academy" }), "reason_locked");
  });
  it("등원 기록의 사유 값은 보지 않음", () => {
    assert.equal(arrivalCancelBlock({ ...base, reason: "illness" }), null);
  });
  it("차감 잠금은 사유보다 먼저", () => {
    assert.equal(arrivalCancelBlock({ ...base, status: "absent", reason: "illness", billed: true }), "billed");
    assert.equal(arrivalCancelBlock({ ...base, billed: true }), "billed");
  });
  it("반 출결이 있으면 가장 먼저", () => {
    assert.equal(arrivalCancelBlock({ ...base, classRecordCount: 2, billed: true }), "has_class_records");
  });
  it("문구", () => {
    assert.equal(
      arrivalCancelClassRecordsMessage(2),
      "오늘 수업 출결이 2건 있어 등원 기록을 취소할 수 없습니다. 출석·결석 기록을 먼저 취소해 주세요.",
    );
    assert.match(ARRIVAL_CANCEL_REASON_LOCKED_MESSAGE, /^질병·학원 사정 미등원은 여기서 취소할 수 없습니다\./);
    assert.equal(CANCEL_NOT_TODAY_MESSAGE, "오늘 기록만 취소할 수 있습니다. 화면을 새로고침해 주세요.");
  });
});

describe("두 attendance-rules.ts가 같은 내용", () => {
  it("머리 주석의 상대 파일 경로 줄(3행)만 다름", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const read = (p) => readFileSync(resolve(here, p), "utf8").replace(/\r\n/g, "\n").split("\n");
    const server = read("../src/lib/attendance-rules.ts");
    const client = read("../../src/lib/academy/attendance-rules.ts");
    assert.equal(server.length, client.length, "줄 수");
    const diff = server.flatMap((line, i) => (line === client[i] ? [] : [i + 1]));
    assert.deepEqual(diff, [3], "3행(서로의 경로를 가리키는 주석) 말고 다른 줄이 있음");
  });
});
