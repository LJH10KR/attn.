/**
 * 2-M 아이디·비밀번호 찾기 판단(`src/lib/account-recovery.ts`)·찾기 한도(`phone-verification.ts`)·
 * 홈 "시작하기" 보임 판단(`src/lib/onboarding.ts`) 단위 테스트 — `npm test`(빌드 후 lib/ 대상)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  foundLoginAccountOf,
  memberRoleOf,
  passwordResetMatch,
  recoveryIndexKeys,
  remainingFloorMs,
  resetLoginIdCounterKey,
  RECOVERY_DUMMY_INDEX_KEY,
} from "../lib/lib/account-recovery.js";
import {
  counterKeys,
  isRecoveryPurpose,
  ISSUABLE_PURPOSES,
  issueLimitsOk,
  octomoBudgetAvailable,
} from "../lib/lib/phone-verification.js";
import {
  OCTOMO_DAILY_CALL_LIMIT_FOR_RECOVERY,
  PHONE_RECOVERY_CODES_PER_IP_PER_HOUR,
} from "../lib/lib/phone-verification-limits.js";
import { isOnboardingAction, onboardingView } from "../lib/lib/onboarding.js";

const KEY = "01012345678";
const verified = { status: "active", phone: "010-1234-5678", phoneVerifiedKey: KEY, authProvider: "password" };

describe("비밀번호 찾기 판단(★8)", () => {
  const match = (patch = {}, opts = {}) =>
    passwordResetMatch({ indexRole: "parent", member: { ...verified, ...patch }, hasPassword: true, proofPhoneKey: KEY, ...opts });

  it("확인된 번호 = 방금 확인한 번호 + 대상 상태면 ok", () => {
    assert.equal(match(), "ok");
    assert.equal(match({ status: "pending_approval" }), "ok");
    assert.equal(match({ status: "pending_registration" }, { indexRole: "teacher" }), "ok");
  });

  it("실패 4종은 모두 같은 no_match — 아이디 없음·번호 다름·미확인·대상 아닌 상태", () => {
    assert.equal(passwordResetMatch({ indexRole: null, member: null, hasPassword: false, proofPhoneKey: KEY }), "no_match");
    assert.equal(match({}, { proofPhoneKey: "01099998888" }), "no_match");
    assert.equal(match({ phoneVerifiedKey: undefined }), "no_match");
    assert.equal(match({ phone: "010-1111-2222" }), "no_match", "계정 번호가 확인 키와 다름(원장이 고침 등)");
    for (const status of ["pending_setup", "inactive", "no_account", undefined]) {
      assert.equal(match({ status }), "no_match", String(status));
    }
    assert.equal(match({}, { indexRole: "owner" }), "no_match");
  });

  it("Google 전용은 다 맞을 때만 google, 비밀번호도 있으면 ok", () => {
    assert.equal(match({ authProvider: "google" }, { hasPassword: false }), "google");
    assert.equal(match({ authProvider: "google" }, { hasPassword: true }), "ok");
    assert.equal(match({ authProvider: "google", status: "inactive" }, { hasPassword: false }), "no_match");
    assert.equal(match({ authProvider: "google" }, { hasPassword: false, proofPhoneKey: "01000000000" }), "no_match");
  });

  it("색인 키 항상 2개(정규화 + 입력 그대로 또는 빈 키), 빈 값·너무 긴 값 거부", () => {
    assert.deepEqual(recoveryIndexKeys(" mykid "), ["mykid", RECOVERY_DUMMY_INDEX_KEY]);
    assert.deepEqual(recoveryIndexKeys("MyKid"), ["mykid", "MyKid"]);
    assert.deepEqual(recoveryIndexKeys("햇살선생님"), ["햇살선생님", RECOVERY_DUMMY_INDEX_KEY]);
    assert.equal(recoveryIndexKeys(""), null);
    assert.equal(recoveryIndexKeys("a".repeat(101)), null);
    assert.equal(recoveryIndexKeys(42), null);
    assert.doesNotMatch(RECOVERY_DUMMY_INDEX_KEY, /^[a-z][a-z0-9_]{3,19}$/, "빈 키는 로그인 ID가 될 수 없음");
  });

  it("아이디별 카운터 키 — 입력 문자열 기준·날짜별·원문 없음", () => {
    const now = Date.UTC(2026, 10, 10, 3);
    const k = resetLoginIdCounterKey("mykid", now);
    assert.match(k, /^reset_id_day_[0-9a-f]{32}_20261110$/);
    assert.ok(!k.includes("mykid"));
    assert.equal(resetLoginIdCounterKey("mykid", now), k);
    assert.notEqual(resetLoginIdCounterKey("other", now), k);
  });

  it("응답 시간 하한", () => {
    assert.equal(remainingFloorMs(1000, 1300, 1200), 900);
    assert.equal(remainingFloorMs(1000, 2500, 1200), 0);
    assert.equal(remainingFloorMs(1000, 900, 1200), 1200);
  });

  it("역할", () => {
    assert.equal(memberRoleOf("parent"), "parent");
    assert.equal(memberRoleOf("teacher"), "teacher");
    assert.equal(memberRoleOf("owner"), null);
  });
});

describe("아이디 찾기 결과 한 줄", () => {
  const data = { ...verified, authUid: "u1", loginId: "mykid", attnId: "o1_a1_p1" };
  it("학부모·직원 경로, 아이디·Google·비활성", () => {
    assert.deepEqual(foundLoginAccountOf("academies/o1_a1/parents/u1", data, KEY), {
      kind: "parent", academyId: "o1_a1", loginId: "mykid", google: false, inactive: false,
    });
    assert.deepEqual(foundLoginAccountOf("academies/o1_a1/staff/u1", { ...data, loginId: "" }, KEY), {
      kind: "teacher", academyId: "o1_a1", loginId: "o1_a1_p1", google: false, inactive: false,
    });
    assert.equal(foundLoginAccountOf("academies/a/parents/u1", { ...data, authProvider: "google" }, KEY).loginId, null);
    assert.equal(foundLoginAccountOf("academies/a/parents/u1", { ...data, authProvider: "google" }, KEY).google, true);
    assert.equal(foundLoginAccountOf("academies/a/staff/u1", { ...data, status: "inactive" }, KEY).inactive, true);
  });
  it("제외 — 다른 경로·계정 없음·번호 바뀜·다른 번호", () => {
    assert.equal(foundLoginAccountOf("users/u1/parents/x", data, KEY), null);
    assert.equal(foundLoginAccountOf("academies/a/staff/x", { ...data, authUid: null, status: "no_account" }, KEY), null);
    assert.equal(foundLoginAccountOf("academies/a/parents/u1", { ...data, phone: "010-0000-1111" }, KEY), null);
    assert.equal(foundLoginAccountOf("academies/a/parents/u1", data, "01000001111"), null);
  });
});

describe("찾기 번호 확인 한도(★6)", () => {
  it("찾기 목적 발급, 범위 키", () => {
    assert.ok(ISSUABLE_PURPOSES.includes("find_login_id"));
    assert.ok(ISSUABLE_PURPOSES.includes("reset_password"));
    assert.equal(isRecoveryPurpose("reset_password"), true);
    assert.equal(isRecoveryPurpose("parent_signup"), false);
    const k = counterKeys({ nowMs: Date.UTC(2026, 10, 10, 3), phoneKey: KEY, ipHash: "abc", uid: null, linkHash: null, recovery: true });
    assert.equal(k.recoveryDay, "recovery_day_20261110");
    assert.equal(k.ipRecoveryHour, "ip_rcv_hr_abc_2026111012");
    const s = counterKeys({ nowMs: 0, phoneKey: KEY, ipHash: "abc", uid: null, linkHash: null });
    assert.equal(s.recoveryDay, null);
    assert.equal(s.ipRecoveryHour, null);
  });
  it("찾기 하루 몫·IP 시간당", () => {
    const base = { globalCount: 0, globalBlockedUntilMs: null, linkCount: null, nowMs: 0 };
    assert.equal(octomoBudgetAvailable({ ...base, recoveryCount: OCTOMO_DAILY_CALL_LIMIT_FOR_RECOVERY - 1 }), true);
    assert.equal(octomoBudgetAvailable({ ...base, recoveryCount: OCTOMO_DAILY_CALL_LIMIT_FOR_RECOVERY }), false);
    assert.equal(octomoBudgetAvailable({ ...base, recoveryCount: null }), true);
    const issue = { phoneHour: 0, phoneDay: 0, ipHour: 0, uidHour: null };
    assert.equal(issueLimitsOk({ ...issue, ipRecoveryHour: PHONE_RECOVERY_CODES_PER_IP_PER_HOUR - 1 }), true);
    assert.equal(issueLimitsOk({ ...issue, ipRecoveryHour: PHONE_RECOVERY_CODES_PER_IP_PER_HOUR }), false);
  });
});

describe("홈 시작하기 보임 판단(★5·★13)", () => {
  const zero = { classes: 0, students: 0, linkedParents: 0, staff: 0 };
  const rec = { parentLinkShared: false, noStaff: false, hidden: false, reopened: false };
  it("기록 없음 = 보임, 단계 완료 기준(M2-1)", () => {
    const v = onboardingView(zero, rec);
    assert.equal(v.visible, true);
    assert.equal(v.doneCount, 0);
    const w = onboardingView({ classes: 1, students: 3, linkedParents: 0, staff: 0 }, { ...rec, parentLinkShared: true, noStaff: true });
    assert.equal(w.allDone, true);
    assert.equal(w.steps.parents.done, true);
    assert.equal(w.steps.staff.noStaff, true);
  });
  it("다 끝나면 사라짐, 숨기기, 다시 켜기", () => {
    const all = { classes: 1, students: 1, linkedParents: 1, staff: 1 };
    assert.equal(onboardingView(all, rec).visible, false);
    assert.equal(onboardingView(all, { ...rec, reopened: true }).visible, true);
    assert.equal(onboardingView(zero, { ...rec, hidden: true }).visible, false);
    assert.equal(onboardingView(zero, { ...rec, hidden: true }).settingOn, false);
  });
  it("동작 이름", () => {
    assert.equal(isOnboardingAction("hide"), true);
    assert.equal(isOnboardingAction("delete"), false);
  });
});
