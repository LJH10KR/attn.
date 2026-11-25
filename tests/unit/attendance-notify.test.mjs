/**
 * 3-B 후속 F2 알림 켜짐 판단(`src/lib/academy/attendance-rules.ts` `isNotifyEnabled`) — `npm run test:unit`.
 * 알림 기록 화면 [다시 보내기] "꺼져 있음"이 쓰는 앱 쪽 사본. 서버 사본(`functions/src/lib/attendance-rules.ts`)과
 * 머리 주석 말고는 같은 파일인지도 함께 본다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { isNotifyEnabled, notifyTypeFor, readNotifySettings } from "../../src/lib/academy/attendance-rules.ts";

const CASES = [
  [{ context: "arrival", kind: "present" }, "arrival"],
  [{ context: "arrival", kind: "absent" }, "arrivalAbsent"],
  [{ context: "departure", kind: "left" }, "departure"],
  [{ context: "class", kind: "present" }, "classPresent"],
  [{ context: "class", kind: "late" }, "classLate"],
  [{ context: "class", kind: "absent" }, "classAbsent"],
];

describe("알림 켜짐(3-B 후속 F2)", () => {
  it("원래 종류 — 취소 알림도 취소한 기록의 종류", () => {
    for (const [p, type] of CASES) assert.equal(notifyTypeFor(p), type);
  });

  it("조합 표 — 기록 = 원래 종류, 취소 = 원래 종류 그리고 정정", () => {
    for (const [p, type] of CASES) {
      for (const baseOn of [true, false]) {
        for (const correctionOn of [true, false]) {
          const settings = { ...readNotifySettings(undefined), [type]: baseOn, correction: correctionOn };
          const tag = `${type} 원래 ${baseOn} 정정 ${correctionOn}`;
          assert.equal(isNotifyEnabled(settings, { ...p, action: "record" }), baseOn, `기록 ${tag}`);
          assert.equal(isNotifyEnabled(settings, { ...p, action: "cancel" }), baseOn && correctionOn, `취소 ${tag}`);
        }
      }
    }
  });

  it("서버 사본과 같은 파일(머리 주석 제외)", () => {
    const body = (path) =>
      readFileSync(new URL(path, import.meta.url), "utf8")
        .replace(/\r\n/g, "\n")
        .split("\n")
        .filter((line) => !line.includes("attendance-rules.ts`와 같은 내용"))
        .join("\n");
    assert.equal(
      body("../../src/lib/academy/attendance-rules.ts"),
      body("../../functions/src/lib/attendance-rules.ts"),
    );
  });
});
