/**
 * 2-L 휴대폰 번호 확인 기반 단위 테스트 — 코드·증표·한도 판단·번호 키·가짜 모드·동의 버전·App Check 1회용
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  counterKeys,
  decideCheckGate,
  hashProofSecret,
  isVerificationId,
  issueLimitsOk,
  newPhoneCode,
  newPhoneProof,
  newVerificationId,
  octomoBudgetAvailable,
  octomoPhoneKey,
  parsePhoneProof,
  seoulDayEndMs,
  seoulDayKey,
  seoulHourKeyOf,
  withinMinutesFor,
  isAccountPhoneVerified,
} from "../lib/lib/phone-verification.js";
import { fakeOctomoResult, maskPhoneKey } from "../lib/lib/octomo.js";
import * as limits from "../lib/lib/phone-verification-limits.js";
import { hasCurrentConsents, LEGAL_DOC_VERSIONS, parseRequiredConsents } from "../lib/lib/legal-docs.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, p), "utf8").replace(/\r\n/g, "\n");

describe("번호 키(OCTOMO 010 11자리)", () => {
  it("형식 정규화", () => {
    assert.equal(octomoPhoneKey("010-1234-5678"), "01012345678");
    assert.equal(octomoPhoneKey("01012345678"), "01012345678");
    assert.equal(octomoPhoneKey("+82 10-1234-5678"), "01012345678");
    assert.equal(octomoPhoneKey("821012345678"), "01012345678");
  });
  it("010이 아니거나 자릿수가 다르면 빈 값", () => {
    assert.equal(octomoPhoneKey("011-123-4567"), "");
    assert.equal(octomoPhoneKey("016-1234-5678"), "");
    assert.equal(octomoPhoneKey("010-123-4567"), "");
    assert.equal(octomoPhoneKey("02-123-4567"), "");
    assert.equal(octomoPhoneKey(""), "");
    assert.equal(octomoPhoneKey(null), "");
  });
  it("두 octomo-phone-key.ts가 같은 내용", () => {
    assert.equal(read("../src/lib/octomo-phone-key.ts"), read("../../src/lib/phone/octomo-phone-key.ts"));
  });
  it("계정 번호 확인됨 판단", () => {
    assert.equal(isAccountPhoneVerified({ phone: "010-1234-5678", phoneVerifiedKey: "01012345678" }), true);
    assert.equal(isAccountPhoneVerified({ phone: "010-1234-9999", phoneVerifiedKey: "01012345678" }), false);
    assert.equal(isAccountPhoneVerified({ phone: "010-1234-5678" }), false);
  });
});

describe("코드·증표", () => {
  it("코드는 숫자 6자리(접두어 없음), 매번 다름", () => {
    const codes = new Set(Array.from({ length: 50 }, () => newPhoneCode()));
    for (const c of codes) assert.match(c, /^\d{6}$/);
    assert.ok(codes.size > 40);
  });
  it("확인 ID 27자, 증표 = id.secret, 해시만 저장", () => {
    const id = newVerificationId();
    assert.ok(isVerificationId(id));
    const { proof, proofHash } = newPhoneProof(id);
    const parsed = parsePhoneProof(proof);
    assert.equal(parsed.verificationId, id);
    assert.equal(hashProofSecret(parsed.secret), proofHash);
    assert.ok(!proof.includes(proofHash));
  });
  it("형식이 틀린 증표는 null", () => {
    const id = newVerificationId();
    assert.equal(parsePhoneProof(""), null);
    assert.equal(parsePhoneProof(id), null);
    assert.equal(parsePhoneProof(`${id}.short`), null);
    assert.equal(parsePhoneProof(`${id}.${"a".repeat(43)}.x`), null);
    assert.equal(parsePhoneProof(123), null);
  });
});

describe("조회 판단", () => {
  const now = 1_800_000_000_000;
  const base = { status: "pending", expiresAtMs: now + 60_000, checkCount: 0, lastCheckAtMs: null, nowMs: now };
  it("정상이면 통과", () => assert.deepEqual(decideCheckGate(base), { ok: true }));
  it("만료", () => assert.equal(decideCheckGate({ ...base, expiresAtMs: now }).status, "expired"));
  it("코드당 3회", () => {
    assert.equal(limits.PHONE_CHECKS_PER_CODE, 3);
    assert.deepEqual(decideCheckGate({ ...base, checkCount: 2 }), { ok: true });
    assert.equal(decideCheckGate({ ...base, checkCount: 3 }).status, "exhausted");
  });
  it("5초 간격", () => {
    const r = decideCheckGate({ ...base, checkCount: 1, lastCheckAtMs: now - 2_000 });
    assert.equal(r.status, "too_soon");
    assert.equal(r.retryAfterMs, 3_000);
    assert.deepEqual(decideCheckGate({ ...base, checkCount: 1, lastCheckAtMs: now - 5_000 }), { ok: true });
  });
  it("이미 확인됨·소진", () => {
    assert.equal(decideCheckGate({ ...base, status: "verified" }).status, "already_verified");
    assert.equal(decideCheckGate({ ...base, status: "exhausted" }).status, "exhausted");
  });
});

describe("한도", () => {
  const now = 1_800_000_000_000;
  it("값(사용자 확정 11-09)", () => {
    assert.equal(limits.OCTOMO_DAILY_CALL_LIMIT, 300);
    assert.equal(limits.OCTOMO_DAILY_CALL_LIMIT_PER_LINK, 150);
    assert.equal(limits.PHONE_CODE_TTL_MS, 10 * 60_000);
    assert.equal(limits.PHONE_PROOF_TTL_MS, 30 * 60_000);
    assert.equal(limits.PHONE_CHECK_MIN_INTERVAL_MS, 5_000);
    assert.equal(limits.PHONE_CODES_PER_PHONE_PER_HOUR, 5);
    assert.equal(limits.PHONE_CODES_PER_PHONE_PER_DAY, 10);
    assert.equal(limits.PHONE_CODES_PER_IP_PER_HOUR, 30);
    assert.ok(limits.OCTOMO_DAILY_CALL_LIMIT * 31 < 10_000);
  });
  it("하루 전체 299 허용, 300 거부", () => {
    assert.equal(octomoBudgetAvailable({ globalCount: 299, globalBlockedUntilMs: null, linkCount: null, nowMs: now }), true);
    assert.equal(octomoBudgetAvailable({ globalCount: 300, globalBlockedUntilMs: null, linkCount: null, nowMs: now }), false);
  });
  it("링크별 150, 429 차단", () => {
    assert.equal(octomoBudgetAvailable({ globalCount: 0, globalBlockedUntilMs: null, linkCount: 149, nowMs: now }), true);
    assert.equal(octomoBudgetAvailable({ globalCount: 0, globalBlockedUntilMs: null, linkCount: 150, nowMs: now }), false);
    assert.equal(octomoBudgetAvailable({ globalCount: 0, globalBlockedUntilMs: now + 1, linkCount: null, nowMs: now }), false);
    assert.equal(octomoBudgetAvailable({ globalCount: 0, globalBlockedUntilMs: now - 1, linkCount: null, nowMs: now }), true);
  });
  it("발급 보조 제한", () => {
    const ok = { phoneHour: 0, phoneDay: 0, ipHour: 0, uidHour: null };
    assert.equal(issueLimitsOk(ok), true);
    assert.equal(issueLimitsOk({ ...ok, phoneHour: 5 }), false);
    assert.equal(issueLimitsOk({ ...ok, phoneDay: 10 }), false);
    assert.equal(issueLimitsOk({ ...ok, ipHour: 30 }), false);
    assert.equal(issueLimitsOk({ ...ok, ipHour: null, uidHour: 5 }), false);
  });
  it("서울 날짜·시각 키와 하루 끝", () => {
    const t = Date.UTC(2026, 10, 9, 15, 30); // 서울 11-10 00:30
    assert.equal(seoulDayKey(t), "20261110");
    assert.equal(seoulHourKeyOf(t), "2026111000");
    assert.equal(seoulDayEndMs(t), Date.UTC(2026, 10, 10, 15, 0));
    const k = counterKeys({ nowMs: t, phoneKey: "01012345678", ipHash: "abc", uid: null, linkHash: "h" });
    assert.equal(k.octomoDay, "octomo_day_20261110");
    assert.equal(k.linkDay, "link_day_h_20261110");
    assert.equal(k.uidHour, null);
  });
  it("withinMinutes = 지난 분 + 1, 1~60", () => {
    assert.equal(withinMinutesFor(now, now), 1);
    assert.equal(withinMinutesFor(now, now + 30_000), 2);
    assert.equal(withinMinutesFor(now, now + 9.5 * 60_000), 11);
    assert.equal(withinMinutesFor(now, now + 5 * 60 * 60_000), 60);
  });
});

describe("가짜 OCTOMO", () => {
  it("끝자리 규칙", () => {
    assert.equal(fakeOctomoResult("01012340000"), "not_found");
    assert.equal(fakeOctomoResult("01012340429"), "rate_limited");
    assert.equal(fakeOctomoResult("01012340500"), "error");
    assert.equal(fakeOctomoResult("01012345678"), "exists");
  });
  it("로그용 번호 가리기", () => assert.equal(maskPhoneKey("01012345678"), "***5678"));
});

describe("App Check 1회용 — 이미 소비된 토큰 거부", () => {
  const run = (flag, app) => {
    const script = `
      const { assertFreshAppCheck } = require(${JSON.stringify(resolve(here, "../lib/lib/app-check.js"))});
      try { assertFreshAppCheck({ app: ${JSON.stringify(app)} }); process.stdout.write("pass"); }
      catch (e) { process.stdout.write("reject:" + e.code); }`;
    const env = { ...process.env };
    if (flag) env.ENFORCE_APP_CHECK = "1";
    else delete env.ENFORCE_APP_CHECK;
    return spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8" }).stdout;
  };
  it("강제 중: alreadyConsumed true면 거부, false·없음은 통과", () => {
    assert.equal(run(true, { alreadyConsumed: true }), "reject:unauthenticated");
    assert.equal(run(true, { alreadyConsumed: false }), "pass");
    assert.equal(run(true, undefined), "pass");
  });
  it("강제 꺼짐: 항상 통과", () => assert.equal(run(false, { alreadyConsumed: true }), "pass"));
});

describe("동의 버전", () => {
  it("서버·화면 버전이 같음", () => {
    const client = read("../../src/lib/legal/legal-docs.ts");
    const pick = (k) => client.match(new RegExp(`${k}: "([^"]+)"`))?.[1];
    assert.equal(pick("terms"), LEGAL_DOC_VERSIONS.terms);
    assert.equal(pick("privacy"), LEGAL_DOC_VERSIONS.privacy);
  });
  it("지금 버전만 통과", () => {
    const c = parseRequiredConsents({ terms: LEGAL_DOC_VERSIONS.terms, privacy: LEGAL_DOC_VERSIONS.privacy });
    assert.equal(c.terms.version, LEGAL_DOC_VERSIONS.terms);
    assert.throws(() => parseRequiredConsents(undefined), /동의해 주세요/);
    assert.throws(() => parseRequiredConsents({ terms: "old", privacy: LEGAL_DOC_VERSIONS.privacy }), /약관이 바뀌었습니다/);
  });
  it("저장 값 판단", () => {
    const cur = { terms: { version: LEGAL_DOC_VERSIONS.terms }, privacy: { version: LEGAL_DOC_VERSIONS.privacy } };
    assert.equal(hasCurrentConsents(cur), true);
    assert.equal(hasCurrentConsents({ ...cur, terms: { version: "old" } }), false);
    assert.equal(hasCurrentConsents(undefined), false);
  });
});
