/**
 * 2-L L-3 보강 — 활성 상태 미러 늦은 덮어쓰기 가드의 비교 키(쓴 값 vs 다시 계산한 값)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { activationSlicesKey, RECONCILE_MAX_ROUNDS } from "../lib/user-activation-mirror.js";

const slice = (anyActive, primaryStatus, primaryAcademyId) => ({ anyActive, primaryStatus, primaryAcademyId });

describe("활성 상태 비교 키", () => {
  it("같은 상태면 같은 키", () => {
    const a = { teacher: slice(true, "active", "a1"), parent: slice(false, null, null) };
    const b = { teacher: slice(true, "active", "a1"), parent: slice(false, null, null) };
    assert.equal(activationSlicesKey(a), activationSlicesKey(b));
  });
  it("대기 → 활성, 학원·역할 조각이 다르면 다른 키", () => {
    const pending = { teacher: slice(false, "pending_registration", "a1"), parent: slice(false, null, null) };
    const active = { teacher: slice(true, "active", "a1"), parent: slice(false, null, null) };
    const other = { teacher: slice(true, "active", "a2"), parent: slice(false, null, null) };
    const parentSide = { teacher: slice(false, null, null), parent: slice(true, "active", "a1") };
    const keys = new Set([pending, active, other, parentSide].map(activationSlicesKey));
    assert.equal(keys.size, 4);
  });
  it("다시 쓰기 횟수 상한", () => {
    assert.ok(RECONCILE_MAX_ROUNDS >= 2 && RECONCILE_MAX_ROUNDS <= 5);
  });
});
