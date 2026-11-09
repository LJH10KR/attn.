/**
 * 2-K 가입 QR 링크·한도·번호 비교·App Check 대상 단위 테스트
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideSignupQuota,
  hashSignupToken,
  newSignupToken,
  parseSignupToken,
  readSignupRate,
  seoulHourKey,
  SIGNUP_HOURLY_LIMITS,
  signupLimitInboxId,
} from "../lib/lib/signup-links.js";
import {
  isStaffSignupMatchCandidate,
  sameStaffPhone,
  staffPhoneMatchKey,
} from "../lib/lib/staff-phone-match.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("가입 토큰", () => {
  it("무작위 32바이트 base64url 43자, 매번 다름", () => {
    const a = newSignupToken();
    const b = newSignupToken();
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b);
    assert.equal(parseSignupToken(a), a);
    assert.equal(parseSignupToken(` ${a} `), a);
  });
  it("형식이 틀리면 null(학원 ID·짧은 값·다른 문자)", () => {
    assert.equal(parseSignupToken(undefined), null);
    assert.equal(parseSignupToken(""), null);
    assert.equal(parseSignupToken("o1_a1"), null);
    assert.equal(parseSignupToken("x".repeat(42)), null);
    assert.equal(parseSignupToken("x".repeat(44)), null);
    assert.equal(parseSignupToken(`${"x".repeat(42)}/`), null);
  });
  it("해시는 sha256 hex", () => {
    assert.equal(hashSignupToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("한도 창 — 서울 시각 정시", () => {
  it("UTC 15시 = 서울 다음 날 0시", () => {
    assert.equal(seoulHourKey(Date.UTC(2026, 10, 9, 14, 59, 59)), "2026110923");
    assert.equal(seoulHourKey(Date.UTC(2026, 10, 9, 15, 0, 0)), "2026111000");
    assert.equal(seoulHourKey(Date.UTC(2026, 11, 31, 15, 30)), "2027010100");
  });
  it("벨 문서 ID", () => {
    assert.equal(signupLimitInboxId("parent", "2026110914"), "signup-limit-parent-2026110914");
  });
});

describe("한도 판단", () => {
  const W = "2026110914";
  it("한도는 학부모 100·직원 20", () => {
    assert.deepEqual(SIGNUP_HOURLY_LIMITS, { parent: 100, staff: 20 });
  });
  it("한도 미만이면 허용하고 1 올림", () => {
    const d = decideSignupQuota({ windowKey: W, count: 98, notifiedWindowKey: null }, W, 100);
    assert.equal(d.allow, true);
    assert.equal(d.notify, false);
    assert.deepEqual(d.nextRate, { windowKey: W, count: 99, notifiedWindowKey: null });
  });
  it("100번째까지 허용, 101번째부터 거부", () => {
    assert.equal(decideSignupQuota({ windowKey: W, count: 99, notifiedWindowKey: null }, W, 100).allow, true);
    const over = decideSignupQuota({ windowKey: W, count: 100, notifiedWindowKey: null }, W, 100);
    assert.equal(over.allow, false);
    assert.equal(over.notify, true, "이 창에 처음 넘으면 알림");
    assert.deepEqual(over.nextRate, { windowKey: W, count: 100, notifiedWindowKey: W });
  });
  it("같은 창에서 알림은 한 번만", () => {
    const again = decideSignupQuota({ windowKey: W, count: 100, notifiedWindowKey: W }, W, 100);
    assert.equal(again.allow, false);
    assert.equal(again.notify, false);
  });
  it("새 창이면 다시 0부터(지난 창 알림 기록은 남아도 됨)", () => {
    const next = decideSignupQuota({ windowKey: W, count: 100, notifiedWindowKey: W }, "2026110915", 100);
    assert.equal(next.allow, true);
    assert.deepEqual(next.nextRate, { windowKey: "2026110915", count: 1, notifiedWindowKey: W });
  });
  it("직원 20 경계", () => {
    assert.equal(decideSignupQuota({ windowKey: W, count: 19, notifiedWindowKey: null }, W, 20).allow, true);
    assert.equal(decideSignupQuota({ windowKey: W, count: 20, notifiedWindowKey: null }, W, 20).allow, false);
  });
  it("카운터 읽기 — 빈 값·이상한 값은 0", () => {
    assert.deepEqual(readSignupRate(undefined), { windowKey: "", count: 0, notifiedWindowKey: null });
    assert.deepEqual(readSignupRate({ windowKey: W, count: -3 }), { windowKey: W, count: 0, notifiedWindowKey: null });
  });
});

describe("직원 번호 비교 — 화면·서버 같은 규칙", () => {
  const same = ["010-1234-5678", "01012345678", "010 1234 5678", "+82 10-1234-5678", "+821012345678", "82-10-1234-5678"];
  it("하이픈·공백·+82는 같은 번호", () => {
    for (const p of same) assert.equal(staffPhoneMatchKey(p), "01012345678", p);
    assert.equal(sameStaffPhone(same[0], same[3]), true);
  });
  it("10자리 휴대폰도 됨", () => {
    assert.equal(staffPhoneMatchKey("011-123-4567"), "0111234567");
  });
  it("휴대폰이 아니거나 비면 어떤 번호와도 같지 않음", () => {
    for (const p of ["", null, undefined, "02-123-4567", "1234", "010-1234-567890"]) {
      assert.equal(staffPhoneMatchKey(p), "", String(p));
    }
    assert.equal(sameStaffPhone("", ""), false);
    assert.equal(sameStaffPhone("010-1234-5678", "010-1234-5679"), false);
  });
  it("후보 = 계정 없음·퇴사 아님·게스트 아님·번호 같음", () => {
    const base = { status: "no_account", employmentStatus: "employed", isGuest: false, phone: "010-1234-5678" };
    assert.equal(isStaffSignupMatchCandidate(base, "+82 10 1234 5678"), true);
    assert.equal(isStaffSignupMatchCandidate({ ...base, employmentStatus: "on_leave" }, "01012345678"), true);
    assert.equal(isStaffSignupMatchCandidate({ ...base, status: "active" }, "01012345678"), false);
    assert.equal(isStaffSignupMatchCandidate({ ...base, employmentStatus: "resigned" }, "01012345678"), false);
    assert.equal(isStaffSignupMatchCandidate({ ...base, isGuest: true }, "01012345678"), false);
    assert.equal(isStaffSignupMatchCandidate({ ...base, phone: null }, "01012345678"), false);
  });
  it("두 staff-phone-match.ts가 같은 내용", () => {
    const read = (p) => readFileSync(resolve(here, p), "utf8").replace(/\r\n/g, "\n");
    assert.equal(read("../src/lib/staff-phone-match.ts"), read("../../src/lib/academy/staff-phone-match.ts"));
  });
});

describe("App Check 강제 대상 — 가입 단계 5개만", () => {
  const ENFORCED = [
    "registerParentSelfSignup",
    "registerParentGoogleSignup",
    "registerStaffSignup",
    "checkParentLoginIdAvailable",
    "checkStaffSignupLoginId",
  ];
  const NOT = [
    "getParentSignupAcademyInfo",
    "getStaffSignupInfo",
    "getParentSignupGoogleStatus",
    "getTeacherActivationState",
    "getParentActivationState",
    "listParentChildrenStudents",
    "getSignupLink",
    "approveStaffSignupAsExisting",
  ];
  /**
   * 각 Callable에 App Check·로그인 토큰 없이 빈 요청을 넣어 본다 — 강제 중이면 SDK가 핸들러 전에
   * 401 "Unauthenticated"로 막고, 아니면 우리 핸들러의 문구(토큰 안내·로그인 필요 등)가 돌아온다.
   * (`onCall`의 endpoint 정보에는 enforceAppCheck가 드러나지 않음)
   */
  const endpoints = (flag) => {
    const script = `
      const m = require(${JSON.stringify(resolve(here, "../lib/index.js"))});
      const probe = (fn) => new Promise((done) => {
        const headers = { "content-type": "application/json" };
        const req = { method: "POST", headers, body: { data: {} }, header: (n) => headers[n.toLowerCase()], get: (n) => headers[n.toLowerCase()] };
        const res = { statusCode: 200, _h: {}, setHeader(k, v) { this._h[k] = v; }, getHeader(k) { return this._h[k]; },
          status(c) { this.statusCode = c; return this; }, send(b) { done(b); }, json(b) { done(b); }, end(b) { done(b); },
          on() {}, once() {}, emit() {}, removeListener() {} };
        Promise.resolve(fn(req, res)).catch(() => done(null));
      });
      (async () => {
        const out = {};
        for (const [k, v] of Object.entries(m)) {
          if (!v || !v.__endpoint || !v.__endpoint.callableTrigger) continue;
          const body = await probe(v);
          out[k] = body?.error?.message === "Unauthenticated";
        }
        process.stdout.write("@@RESULT@@" + JSON.stringify(out));
        process.exit(0);
      })();`;
    const env = { ...process.env, GCLOUD_PROJECT: "demo-attn" };
    if (flag) env.ENFORCE_APP_CHECK = "1";
    else delete env.ENFORCE_APP_CHECK;
    const r = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.split("@@RESULT@@")[1]);
  };
  it("플래그가 켜지면 5개만 true", () => {
    const on = endpoints(true);
    for (const n of ENFORCED) assert.equal(on[n], true, n);
    for (const n of NOT) assert.equal(on[n], false, n);
    const enforced = Object.entries(on).filter(([, v]) => v === true).map(([k]) => k).sort();
    assert.deepEqual(enforced, [...ENFORCED].sort());
  });
  it("플래그가 없으면 모두 false", () => {
    const off = endpoints(false);
    assert.deepEqual(Object.entries(off).filter(([, v]) => v === true), []);
  });
  it("폐지한 1인 초대 함수는 export에 없음", () => {
    const off = endpoints(false);
    for (const n of ["createStaffInvite", "cancelStaffInvite", "getStaffInviteInfo", "checkStaffInviteLoginId", "acceptStaffInvite"]) {
      assert.equal(n in off, false, n);
    }
    for (const n of ["getSignupLink", "regenerateSignupLink", "setSignupLinkEnabled", "registerStaffSignup", "setStaffSignupRole", "approveStaffSignupAsExisting", "getStaffSignupInfo", "checkStaffSignupLoginId", "createStaffAccounts"]) {
      assert.equal(n in off, true, n);
    }
  });
});
