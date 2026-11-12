/**
 * 2-N 회원 탈퇴·학원 삭제 판단 단위 테스트 — `npm test`(빌드 후 lib/ 대상)
 * 최근 인증(`recent-auth.ts`), 탈퇴 막힘·벨 ID(`account-withdrawal.ts`), 직원 인사 기록 남김(`account-membership.ts`),
 * 소속 경로 해석(`account-use.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isRecentAuth, RECENT_AUTH_MAX_AGE_MS } from "../lib/lib/recent-auth.js";
import {
  WITHDRAWAL_BLOCK_MESSAGE,
  withdrawalBlock,
  withdrawnBellId,
} from "../lib/lib/account-withdrawal.js";
import { keepsStaffHrRecord } from "../lib/lib/account-membership.js";
import { academyIdOfMemberPath } from "../lib/lib/account-use.js";

describe("isRecentAuth", () => {
  const now = 1_800_000_000_000;
  const sec = (ms) => Math.floor(ms / 1000);
  it("5분 안은 통과, 넘으면 거부(경계 포함)", () => {
    assert.equal(RECENT_AUTH_MAX_AGE_MS, 5 * 60 * 1000);
    assert.equal(isRecentAuth(sec(now), now), true);
    assert.equal(isRecentAuth(sec(now - 4 * 60 * 1000), now), true);
    assert.equal(isRecentAuth((now - RECENT_AUTH_MAX_AGE_MS) / 1000, now), true, "정확히 5분");
    assert.equal(isRecentAuth((now - RECENT_AUTH_MAX_AGE_MS - 1000) / 1000, now), false);
    assert.equal(isRecentAuth(sec(now - 60 * 60 * 1000), now), false);
  });
  it("시계 차이 1분까지 미래 값 허용, 그보다 크면 거부", () => {
    assert.equal(isRecentAuth(sec(now + 30 * 1000), now), true);
    assert.equal(isRecentAuth(sec(now + 5 * 60 * 1000), now), false);
  });
  it("값이 없거나 이상하면 거부", () => {
    for (const v of [undefined, null, "123", 0, -1, NaN, Infinity]) assert.equal(isRecentAuth(v, now), false, String(v));
  });
  it("허용 시간을 바꿀 수 있다(에뮬레이터 시험용)", () => {
    assert.equal(isRecentAuth(sec(now) - 2, now, 1), false);
  });
});

describe("withdrawalBlock", () => {
  it("관리자 > 소유 학원 > 통과", () => {
    assert.equal(withdrawalBlock(true, 3), "admin");
    assert.equal(withdrawalBlock(false, 1), "owns_academies");
    assert.equal(withdrawalBlock(false, 0), null);
    assert.match(WITHDRAWAL_BLOCK_MESSAGE.owns_academies, /학원을 먼저 삭제/);
  });
  it("벨 ID는 역할·계정마다 하나(같은 학원에 학부모·직원 둘 다여도 따로)", () => {
    assert.equal(withdrawnBellId("parent", "u1"), "withdrawn-parent-u1");
    assert.notEqual(withdrawnBellId("parent", "u1"), withdrawnBellId("teacher", "u1"));
  });
});

describe("keepsStaffHrRecord", () => {
  it("사용 중·비활성이고 게스트가 아니면 인사 기록을 남김", () => {
    assert.equal(keepsStaffHrRecord("active", undefined, false), true);
    assert.equal(keepsStaffHrRecord("inactive", false, false), true);
  });
  it("대기·게스트·인사 기록도 지우기는 남기지 않음", () => {
    for (const st of ["pending_registration", "pending_setup", "invitation_sent", "no_account", undefined]) {
      assert.equal(keepsStaffHrRecord(st, false, false), false, String(st));
    }
    assert.equal(keepsStaffHrRecord("active", true, false), false, "게스트");
    assert.equal(keepsStaffHrRecord("active", false, true), false, "인사 기록도 지우기");
  });
});

describe("academyIdOfMemberPath", () => {
  it("학원 직원·학부모 문서 경로만", () => {
    assert.equal(academyIdOfMemberPath("academies/o1_a1/staff/u1", "staff"), "o1_a1");
    assert.equal(academyIdOfMemberPath("academies/o1_a1/parents/u1", "parents"), "o1_a1");
    assert.equal(academyIdOfMemberPath("academies/o1_a1/parents/u1", "staff"), null);
    assert.equal(academyIdOfMemberPath("other/x/staff/u1", "staff"), null);
    assert.equal(academyIdOfMemberPath("academies/o1_a1/staff/u1/secrets/login", "staff"), null);
  });
});
