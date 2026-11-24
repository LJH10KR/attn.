/**
 * 원장 이메일 인증(3-A 후속 [Fix]) 단위 테스트 — `npm test`(빌드 후 lib/ 대상)
 * - F1 decideAutoIssue: 최근 보낸 유효 코드 재사용(10분·남은 5분), 60초 cooldown, 이메일 바뀜, 시도 소진
 * - B1 issueOtpWith: 보내기 실패하면 코드 문서를 지워 recent·cooldown이 되지 않음
 * - F2 googleEmailVerificationDecision: Google 이메일 == 계정 이메일일 때만 verify
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_REUSE_MIN_REMAINING_MS,
  AUTO_REUSE_WINDOW_MS,
  decideAutoIssue,
  googleEmailVerificationDecision,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  RESEND_COOLDOWN_MS,
} from "../lib/lib/email-verification-policy.js";
import {
  hashOtp,
  issueOtpWith,
  OtpCooldownError,
} from "../lib/lib/email-verification-issue.js";

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
const EMAIL = "owner@t.dev";

function stored(sentAgoMs, extra = {}) {
  return {
    now: NOW,
    deliveredAtMs: NOW - sentAgoMs,
    expiresAtMs: NOW - sentAgoMs + OTP_TTL_MS,
    attempts: 0,
    storedEmail: EMAIL,
    email: EMAIL,
    ...extra,
  };
}

describe("decideAutoIssue (F1)", () => {
  it("상수 — 10분 재사용·남은 5분·60초", () => {
    assert.equal(AUTO_REUSE_WINDOW_MS, 10 * MIN);
    assert.equal(AUTO_REUSE_MIN_REMAINING_MS, 5 * MIN);
    assert.equal(RESEND_COOLDOWN_MS, MIN);
    assert.equal(OTP_TTL_MS, 15 * MIN);
  });

  it("보낸 코드 없음(문서 없음·보내지 못한 문서) → send", () => {
    assert.equal(
      decideAutoIssue({ now: NOW, deliveredAtMs: null, expiresAtMs: null, attempts: 0, storedEmail: null, email: EMAIL }),
      "send",
    );
    assert.equal(decideAutoIssue({ ...stored(10_000), deliveredAtMs: null }), "send");
  });

  it("10분 안·남은 5분 이상 → recent(10초·5분·9분 59초)", () => {
    assert.equal(decideAutoIssue(stored(10_000)), "recent");
    assert.equal(decideAutoIssue(stored(5 * MIN)), "recent");
    assert.equal(decideAutoIssue(stored(10 * MIN - 1)), "recent");
  });

  it("10분 지남 → send", () => {
    assert.equal(decideAutoIssue(stored(10 * MIN)), "send");
    assert.equal(decideAutoIssue(stored(14 * MIN)), "send");
  });

  it("남은 시간 5분 미만이면 10분 안이어도 send", () => {
    assert.equal(decideAutoIssue({ ...stored(3 * MIN), expiresAtMs: NOW + 5 * MIN - 1 }), "send");
    assert.equal(decideAutoIssue({ ...stored(3 * MIN), expiresAtMs: NOW + 5 * MIN }), "recent");
  });

  it("이메일 바뀜(대소문자·공백은 같은 것으로) → send", () => {
    assert.equal(decideAutoIssue({ ...stored(2 * MIN), storedEmail: "old@t.dev" }), "send");
    assert.equal(decideAutoIssue({ ...stored(2 * MIN), storedEmail: " Owner@T.dev " }), "recent");
  });

  it("시도 소진: 60초 안 → cooldown, 지나면 send", () => {
    assert.equal(decideAutoIssue({ ...stored(30_000), attempts: OTP_MAX_ATTEMPTS }), "cooldown");
    assert.equal(decideAutoIssue({ ...stored(MIN), attempts: OTP_MAX_ATTEMPTS }), "send");
  });

  it("60초 안인데 이메일이 바뀌었어도 cooldown(메일 폭주 방지)", () => {
    assert.equal(decideAutoIssue({ ...stored(10_000), storedEmail: "old@t.dev" }), "cooldown");
  });
});

/** 메모리 저장소 — issueOtpWith용 */
function memStore(initial = null) {
  let doc = initial;
  return {
    get doc() {
      return doc;
    },
    store: {
      async get() {
        return doc ? { ...doc } : null;
      },
      async replace(d) {
        doc = { codeHash: d.codeHash, email: d.email, attempts: 0, expiresAtMs: d.expiresAtMs, deliveredAtMs: null };
      },
      async markDelivered(at) {
        doc = { ...doc, deliveredAtMs: at };
      },
      async deleteIfCodeHash(h) {
        if (doc && doc.codeHash === h) doc = null;
      },
    },
  };
}

describe("issueOtpWith (F1·B1)", () => {
  const now = () => NOW;

  it("resend: 새 코드 저장 → 보냄 → deliveredAt", async () => {
    const m = memStore();
    const sent = [];
    const r = await issueOtpWith(
      { store: m.store, send: async (c) => void sent.push(c), now, generate: () => "123456" },
      { email: EMAIL, mode: "resend" },
    );
    assert.deepEqual(r, { sent: true, code: "123456" });
    assert.deepEqual(sent, ["123456"]);
    assert.equal(m.doc.codeHash, hashOtp("123456"));
    assert.equal(m.doc.deliveredAtMs, NOW);
  });

  it("auto: 최근 보낸 코드가 있으면 보내지 않고 recent, 코드도 그대로", async () => {
    const m = memStore({ codeHash: hashOtp("111111"), email: EMAIL, attempts: 0, deliveredAtMs: NOW - MIN * 2, expiresAtMs: NOW + 13 * MIN });
    let calls = 0;
    const r = await issueOtpWith(
      { store: m.store, send: async () => void calls++, now },
      { email: EMAIL, mode: "auto" },
    );
    assert.deepEqual(r, { sent: false, reason: "recent" });
    assert.equal(calls, 0);
    assert.equal(m.doc.codeHash, hashOtp("111111"));
  });

  it("resend: 60초 안에 보낸 코드가 있으면 cooldown 오류", async () => {
    const m = memStore({ codeHash: "x", email: EMAIL, attempts: 0, deliveredAtMs: NOW - 10_000, expiresAtMs: NOW + 14 * MIN });
    await assert.rejects(
      issueOtpWith({ store: m.store, send: async () => {}, now }, { email: EMAIL, mode: "resend" }),
      OtpCooldownError,
    );
  });

  it("B1 보내기 실패 → 코드 문서 지움 → auto는 다시 send, resend도 cooldown 없이 바로 됨", async () => {
    const m = memStore();
    await assert.rejects(
      issueOtpWith(
        { store: m.store, send: async () => { throw new Error("smtp down"); }, now, generate: () => "222222" },
        { email: EMAIL, mode: "auto" },
      ),
      /smtp down/,
    );
    assert.equal(m.doc, null);
    const again = await issueOtpWith(
      { store: m.store, send: async () => {}, now, generate: () => "333333" },
      { email: EMAIL, mode: "resend" },
    );
    assert.deepEqual(again, { sent: true, code: "333333" });
  });

  it("B1 보내기 실패 중 다른 발급이 덮었으면 그 문서는 지우지 않음", async () => {
    const m = memStore();
    await assert.rejects(
      issueOtpWith(
        {
          store: m.store,
          send: async () => {
            await m.store.replace({ codeHash: "other", email: EMAIL, expiresAtMs: NOW + OTP_TTL_MS });
            throw new Error("fail");
          },
          now,
          generate: () => "444444",
        },
        { email: EMAIL, mode: "resend" },
      ),
    );
    assert.equal(m.doc.codeHash, "other");
  });
});

describe("googleEmailVerificationDecision (F2)", () => {
  const g = (email) => ({ providerId: "google.com", email });
  const pw = (email) => ({ providerId: "password", email });

  it("Google 이메일 == 계정 이메일(대소문자·공백 무시) → verify", () => {
    assert.equal(
      googleEmailVerificationDecision({ email: "Owner@Gmail.com", emailVerified: false, providerData: [pw("owner@gmail.com"), g(" owner@gmail.com ")] }),
      "verify",
    );
  });

  it("다른 사람 이메일로 만든 비밀번호 계정 + 내 Google(다른 이메일) → mismatch", () => {
    assert.equal(
      googleEmailVerificationDecision({ email: "victim@t.dev", emailVerified: false, providerData: [pw("victim@t.dev"), g("attacker@gmail.com")] }),
      "mismatch",
    );
  });

  it("Google 없음 → no_google, Google 이메일 비어 있음 → mismatch", () => {
    assert.equal(googleEmailVerificationDecision({ email: "a@t.dev", emailVerified: false, providerData: [pw("a@t.dev")] }), "no_google");
    assert.equal(googleEmailVerificationDecision({ email: "a@t.dev", emailVerified: false }), "no_google");
    assert.equal(googleEmailVerificationDecision({ email: "a@t.dev", emailVerified: false, providerData: [g(null)] }), "mismatch");
  });

  it("내부 이메일 → internal(Google 이메일이 같아도)", () => {
    const internal = "t_1@provision.attndot.internal";
    assert.equal(googleEmailVerificationDecision({ email: internal, emailVerified: false, providerData: [g(internal)] }), "internal");
  });

  it("이미 인증 → already, 계정 이메일 없음 → no_email", () => {
    assert.equal(googleEmailVerificationDecision({ email: "a@t.dev", emailVerified: true, providerData: [] }), "already");
    assert.equal(googleEmailVerificationDecision({ email: null, emailVerified: false, providerData: [g("a@t.dev")] }), "no_email");
  });
});
