/**
 * 로그인 연속 실패 제한(`src/lib/login-throttle.ts`) 단위 테스트 — `npm test` (빌드 후 lib/ 대상)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  beginLoginAttempt,
  LOGIN_LOCK_MS,
  LOGIN_MAX_FAILURES,
  LOGIN_THROTTLE_RESET,
  lockedLoginMessage,
} from "../lib/lib/login-throttle.js";

const NOW = 1_800_000_000_000;

/** 실패만 n번 — 시도마다 상태를 이어 붙임 */
function failTimes(n, start = LOGIN_THROTTLE_RESET, now = NOW) {
  let state = start;
  const decisions = [];
  for (let i = 0; i < n; i++) {
    const d = beginLoginAttempt(state, now);
    decisions.push(d);
    if (d.next) state = d.next;
  }
  return { state, decisions };
}

describe("beginLoginAttempt", () => {
  it(`연속 ${LOGIN_MAX_FAILURES}번까지는 시도할 수 있고, 그다음 시도에서 잠긴다`, () => {
    const { decisions, state } = failTimes(LOGIN_MAX_FAILURES + 1);
    assert.ok(decisions.slice(0, LOGIN_MAX_FAILURES).every((d) => d.allowed));
    const locked = decisions[LOGIN_MAX_FAILURES];
    assert.equal(locked.allowed, false);
    assert.equal(locked.retryAfterMs, LOGIN_LOCK_MS);
    assert.equal(state.lockedUntilMillis, NOW + LOGIN_LOCK_MS);
  });

  it("잠금 중에는 계속 거부하고 상태를 바꾸지 않는다(잠금 연장 없음)", () => {
    const { state } = failTimes(LOGIN_MAX_FAILURES + 1);
    const d = beginLoginAttempt(state, NOW + 60_000);
    assert.equal(d.allowed, false);
    assert.equal(d.next, null);
    assert.equal(d.retryAfterMs, LOGIN_LOCK_MS - 60_000);
  });

  it("잠금 시간이 지나면 처음부터 다시 센다", () => {
    const { state } = failTimes(LOGIN_MAX_FAILURES + 1);
    const later = NOW + LOGIN_LOCK_MS + 1;
    const d = beginLoginAttempt(state, later);
    assert.equal(d.allowed, true);
    assert.deepEqual(d.next, { failures: 1, lockedUntilMillis: null });
  });

  it("성공으로 초기화하면 다시 한도만큼 시도할 수 있다", () => {
    const { state } = failTimes(LOGIN_MAX_FAILURES - 1);
    assert.equal(state.failures, LOGIN_MAX_FAILURES - 1);
    const { decisions } = failTimes(LOGIN_MAX_FAILURES, LOGIN_THROTTLE_RESET);
    assert.ok(decisions.every((d) => d.allowed));
  });
});

describe("lockedLoginMessage", () => {
  it("남은 시간을 분 단위(올림, 최소 1분)로 알려 준다", () => {
    assert.match(lockedLoginMessage(LOGIN_LOCK_MS), /15분/);
    assert.match(lockedLoginMessage(61_000), /2분/);
    assert.match(lockedLoginMessage(500), /1분/);
  });
});
