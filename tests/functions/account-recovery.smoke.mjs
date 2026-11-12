/**
 * 아이디·비밀번호 찾기(2-M) 통합 스모크 — `npm run test:functions`(가짜 OCTOMO).
 * - 번호 확인: 찾기 목적은 토큰·로그인 없이 발급(범위 recovery), IP별 찾기 코드 10/시간, 찾기 전용 하루 몫 60.
 * - 아이디 찾기: 학원 2곳·학부모/직원·Google(아이디 대신 Google)·비활성 표시, 미확인·번호 바뀐 계정 제외, 증표 1회.
 * - 비밀번호 찾기: 한 문구 실패 4종(아이디 없음·번호 다름·미확인·대상 아닌 상태)이 응답·시간 하한까지 같음, Google 안내,
 *   아이디별 하루 5번, 증표·표 1회·만료, 성공 → 옛 비밀번호 실패·새 비밀번호 로그인·다른 세션 끊김·잠금 해제·원장 벨(번호 없음),
 *   계정 상태·클레임은 그대로(B3 — 승인 대기 학부모·가입 승인 대기 직원).
 * - 증표 용도 양방향(B2): 가입·번호 변경 증표로 찾기 거부, 찾기 증표로 가입 3개·번호 변경 3개 거부.
 */
import assert from "node:assert/strict";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb, Timestamp } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  GoogleAuthProvider,
  signInWithCredential,
  signInWithCustomToken,
  signOut,
} from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { createRequire } from "node:module";
import { CONSENTS, seedSignupToken } from "./_signup-token.mjs";

const requireCjs = createRequire(import.meta.url);
const { counterKeys } = requireCjs("../../functions/lib/lib/phone-verification.js");
const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A1 = "o22_a1";
const A2 = "o22_a2";

const owner = await adminAuth().createUser({ email: "owner22@t.dev", password: "pass1234", emailVerified: true });
for (const [id, name] of [[A1, "찾기 학원"], [A2, "둘째 학원"]]) {
  await db.doc(`academies/${id}`).set({ ownerUid: owner.uid, name, status: "active" });
  await db.doc(`academies/${id}/meta/seq`).set({ nextTeacherSeq: 1, nextParentSeq: 1, nextStudentSeq: 1 });
}
const PA1 = await seedSignupToken(db, A1, "parent");
const SA1 = await seedSignupToken(db, A1, "staff");
const SA2 = await seedSignupToken(db, A2, "staff");

const config = { projectId: PROJECT, apiKey: "fake" };
const app = initializeApp(config);
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 번호별·IP별 발급 제한 카운터 정리(이 스모크는 같은 번호·IP로 여러 번 확인함) */
async function clearIssueCounters() {
  for (const d of (await db.collection("phoneVerificationCounters").get()).docs) {
    if (/^(phone_hr_|phone_day_|ip_hr_|ip_rcv_hr_)/.test(d.id)) await d.ref.delete();
  }
}
async function proof(phone, purpose, token) {
  await clearIssueCounters();
  const s = await call("startPhoneVerification", { purpose, phone, ...(token ? { token } : {}) });
  assert.equal(s.status, "issued", `${purpose} 발급`);
  const c = await call("checkPhoneVerification", { verificationId: s.verificationId });
  assert.equal(c.status, "verified", `${purpose} 확인`);
  return c.proof;
}
const findProof = (phone) => proof(phone, "find_login_id");
const resetProof = (phone) => proof(phone, "reset_password");

const X = "010-6100-0001";
const XKEY = "01061000001";
const Y = "010-6100-0002";

// --- 계정 준비(실제 가입 경로) ---
async function parentSignup(loginId, phone, verify = true) {
  await signOut(auth);
  const res = await call("registerParentSelfSignup", {
    token: PA1, loginId, displayName: `학부모 ${loginId}`, phone, password: "pw123456", consents: CONSENTS,
    ...(verify ? { phoneProof: await proof(phone, "parent_signup", PA1) } : {}),
  });
  return (await db.doc(`attnLoginIndex/${res.loginId}`).get()).get("authUid");
}
async function staffSignup(token, loginId, phone) {
  await signOut(auth);
  await call("registerStaffSignup", {
    token, method: "password", displayName: `직원 ${loginId}`, phone, loginId, password: "pw123456", consents: CONSENTS,
    phoneProof: await proof(phone, "staff_signup", token),
  });
  return (await db.doc(`attnLoginIndex/${loginId}`).get()).get("authUid");
}
const pv = await parentSignup("findpv", X);
const pu = await parentSignup("findpu", X, false);
const ps = await parentSignup("findps", X);
const pc = await parentSignup("findpc", X);
const sv = await staffSignup(SA2, "findsv", X);
const si = await staffSignup(SA1, "findsi", X);
await signOut(auth);
const gProof = await proof(X, "parent_signup", PA1);
const gUser = (await signInWithCredential(
  auth,
  GoogleAuthProvider.credential(JSON.stringify({ sub: "find-g-1", email: "findg1@gmail.com", email_verified: true })),
)).user;
await call("registerParentGoogleSignup", { token: PA1, displayName: "구글 학부모", phone: X, consents: CONSENTS, phoneProof: gProof });
await signOut(auth);
// 대상 아닌 상태·번호 바뀜·비활성은 Admin으로 만든다
await db.doc(`academies/${A1}/parents/${ps}`).update({ status: "pending_setup" });
await db.doc(`academies/${A1}/parents/${pc}`).update({ phone: "010-6100-0099" });
await db.doc(`academies/${A1}/staff/${si}`).update({ status: "inactive" });
assert.equal((await db.doc(`academies/${A1}/parents/${pv}`).get()).get("phoneVerifiedKey"), XKEY);
assert.equal((await db.doc(`academies/${A1}/parents/${pu}`).get()).get("phoneVerifiedKey"), undefined);

// --- 번호 확인: 찾기 목적은 토큰·로그인 없이, 범위 recovery ---
await clearIssueCounters();
const st = await call("startPhoneVerification", { purpose: "find_login_id", phone: X });
assert.equal(st.status, "issued");
assert.deepEqual((await db.doc(`phoneVerifications/${st.verificationId}`).get()).get("scope"), { recovery: true });
// IP별 찾기 코드 10/시간(번호는 달라도) — 에뮬레이터는 Callable에 클라이언트 IP를 주지 않아 HTTP로 x-forwarded-for를 넣어 부른다
const startFromIp = async (ip, data) => {
  const res = await fetch(`http://127.0.0.1:5001/${PROJECT}/asia-northeast3/startPhoneVerification`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ data }),
  });
  return (await res.json()).result;
};
await clearIssueCounters();
for (let i = 0; i < 10; i += 1) {
  assert.equal((await startFromIp("203.0.113.7", { purpose: "reset_password", phone: `010-6199-${1000 + i}` })).status, "issued");
}
assert.equal((await startFromIp("203.0.113.7", { purpose: "reset_password", phone: "010-6199-2000" })).status, "unavailable");
assert.equal((await startFromIp("203.0.113.8", { purpose: "reset_password", phone: "010-6199-2000" })).status, "issued", "다른 IP");
// 가입 목적은 IP 찾기 제한과 무관(가입 IP 제한 30/시간은 따로)
assert.equal((await startFromIp("203.0.113.7", { purpose: "parent_signup", token: PA1, phone: "010-6199-2001" })).status, "issued");
// 찾기 전용 하루 몫 60
await clearIssueCounters();
const day = counterKeys({ nowMs: Date.now(), phoneKey: "", ipHash: null, uid: null, linkHash: null, recovery: true }).recoveryDay;
const dayRef = db.doc(`phoneVerificationCounters/${day}`);
const savedRecovery = (await dayRef.get()).get("count") ?? 0;
await dayRef.set({ count: 60 }, { merge: true });
assert.equal((await call("startPhoneVerification", { purpose: "find_login_id", phone: X })).status, "unavailable", "찾기 몫이 차면 발급 안 함");
assert.equal(
  (await call("startPhoneVerification", { purpose: "parent_signup", token: PA1, phone: "010-6199-2002" })).status,
  "issued", "가입 확인은 찾기 몫과 무관",
);
await dayRef.set({ count: savedRecovery }, { merge: true });
const checkedBefore = (await dayRef.get()).get("count");
await findProof("010-6100-0088");
assert.equal((await dayRef.get()).get("count"), checkedBefore + 1, "찾기 조회 1번 = 찾기 몫 1건");

// --- 아이디 찾기 ---
const fp = await findProof(X);
const found = await call("findLoginIdsByPhone", { phone: X, phoneProof: fp });
assert.equal(found.status, "ok");
const view = found.accounts.map((a) => `${a.kind}|${a.academyName}|${a.loginId}|${a.google}|${a.inactive}`).sort();
assert.deepEqual(view, [
  "parent|찾기 학원|findps|false|false",
  "parent|찾기 학원|findpv|false|false",
  "parent|찾기 학원|null|true|false",
  "teacher|둘째 학원|findsv|false|false",
  "teacher|찾기 학원|findsi|false|true",
].sort(), "미확인(findpu)·번호 바뀜(findpc) 제외, Google은 아이디 대신, 비활성 표시");
assert.ok(!JSON.stringify(found).includes("010"), "번호를 돌려주지 않음");
await assert.rejects(call("findLoginIdsByPhone", { phone: X, phoneProof: fp }), /번호 확인을 다시/, "증표 1회");
await assert.rejects(call("findLoginIdsByPhone", { phone: Y, phoneProof: await findProof(X) }), /입력한 번호가 다릅니다/);
const none = await call("findLoginIdsByPhone", { phone: "010-6100-0077", phoneProof: await findProof("010-6100-0077") });
assert.deepEqual(none.accounts, []);

// --- B2: 증표 용도 양방향 ---
await assert.rejects(
  call("findLoginIdsByPhone", { phone: X, phoneProof: await proof(X, "parent_signup", PA1) }),
  /번호 확인을 다시/, "가입 증표로 아이디 찾기 불가",
);
await assert.rejects(
  call("verifyPasswordResetTarget", { loginId: "findpv", phone: X, phoneProof: await proof(X, "staff_signup", SA1) }),
  /번호 확인을 다시/, "가입 증표로 비밀번호 찾기 불가",
);
await assert.rejects(
  call("findLoginIdsByPhone", { phone: X, phoneProof: await resetProof(X) }), /번호 확인을 다시/, "재설정 증표로 아이디 찾기 불가",
);
await assert.rejects(
  call("verifyPasswordResetTarget", { loginId: "findpv", phone: X, phoneProof: await findProof(X) }),
  /번호 확인을 다시/, "아이디 찾기 증표로 비밀번호 찾기 불가",
);
await assert.rejects(
  call("registerParentSelfSignup", {
    token: PA1, loginId: "b2parent", displayName: "b2", phone: X, password: "pw123456", consents: CONSENTS,
    phoneProof: await findProof(X),
  }),
  /번호 확인을 다시/, "찾기 증표로 학부모 가입 불가",
);
await assert.rejects(
  call("registerStaffSignup", {
    token: SA1, method: "password", displayName: "b2", phone: X, loginId: "b2staff1", password: "pw123456",
    consents: CONSENTS, phoneProof: await resetProof(X),
  }),
  /번호 확인을 다시/, "찾기 증표로 직원 가입 불가",
);
const b2gProof = await findProof(X);
await signInWithCredential(
  auth,
  GoogleAuthProvider.credential(JSON.stringify({ sub: "find-g-2", email: "findg2@gmail.com", email_verified: true })),
);
await assert.rejects(
  call("registerParentGoogleSignup", { token: PA1, displayName: "b2", phone: X, consents: CONSENTS, phoneProof: b2gProof }),
  /번호 확인을 다시/, "찾기 증표로 Google 가입 불가",
);
await signOut(auth);
const loginAs = async (fn, loginId, password = "pw123456") => {
  const r = await call(fn, { loginId, password });
  await signInWithCustomToken(auth, r.customToken);
  return r;
};
const pvChange = await findProof(X);
const pvNotice = await resetProof(X);
await loginAs("signInParent", "findpv");
await assert.rejects(call("updateParentProfile", { phone: X, phoneProof: pvChange }), /번호 확인을 다시/, "찾기 증표로 학부모 번호 변경 불가");
await assert.rejects(
  call("resolveParentPhoneNotice", { action: "confirm", studentId: "s1", phone: X, phoneProof: pvNotice }),
  /번호 확인을 다시/, "찾기 증표로 안내 창 확인 불가",
);
// 번호 변경 증표(로그인 본인)로 아이디 찾기 불가
const changeProof = await proof(X, "phone_change");
await assert.rejects(call("findLoginIdsByPhone", { phone: X, phoneProof: changeProof }), /번호 확인을 다시/);
await signOut(auth);
const svChange = await findProof(X);
await loginAs("signInTeacher", "findsv");
await assert.rejects(call("updateTeacherProfile", { phone: X, phoneProof: svChange }), /번호 확인을 다시/, "찾기 증표로 직원 번호 변경 불가");
await signOut(auth);

// --- 비밀번호 찾기: 한 문구 실패 4종이 같은 응답·시간 하한 ---
const timed = async (data) => {
  const t = Date.now();
  const r = await call("verifyPasswordResetTarget", data);
  return { r, ms: Date.now() - t };
};
const failures = {
  noSuchId: await timed({ loginId: "nosuchid22", phone: X, phoneProof: await resetProof(X) }),
  otherPhone: await timed({ loginId: "findpv", phone: Y, phoneProof: await resetProof(Y) }),
  unverified: await timed({ loginId: "findpu", phone: X, phoneProof: await resetProof(X) }),
  notTarget: await timed({ loginId: "findps", phone: X, phoneProof: await resetProof(X) }),
  phoneChanged: await timed({ loginId: "findpc", phone: X, phoneProof: await resetProof(X) }),
  inactive: await timed({ loginId: "findsi", phone: X, phoneProof: await resetProof(X) }),
};
for (const [label, { r, ms }] of Object.entries(failures)) {
  assert.deepEqual(r, { status: "no_match" }, label);
  assert.ok(ms >= 1200, `${label}: 시간 하한(${ms}ms)`);
}
console.log(`[찾기] 한 문구 실패 응답 시간(ms): ${Object.entries(failures).map(([k, v]) => `${k}=${v.ms}`).join(", ")}`);

// Google 전용 — 다 맞을 때만 안내
assert.deepEqual(
  await call("verifyPasswordResetTarget", { loginId: "findg1@gmail.com", phone: X, phoneProof: await resetProof(X) }),
  { status: "google" },
);
assert.deepEqual(
  await call("verifyPasswordResetTarget", { loginId: "findg1@gmail.com", phone: Y, phoneProof: await resetProof(Y) }),
  { status: "no_match" },
);
assert.equal((await db.doc(`academies/${A1}/parents/${gUser.uid}`).get()).get("passwordResetAt"), undefined);

// 아이디별 하루 5번(입력 문자열 기준 — 없는 아이디도 같음), 한도면 증표를 쓰지 않음
for (let i = 0; i < 5; i += 1) {
  assert.deepEqual(
    await call("verifyPasswordResetTarget", { loginId: "LimitId22", phone: X, phoneProof: await resetProof(X) }),
    { status: "no_match" },
  );
}
const limitedProof = await resetProof(X);
assert.deepEqual(
  await call("verifyPasswordResetTarget", { loginId: "limitid22", phone: X, phoneProof: limitedProof }),
  { status: "limited" }, "대소문자만 다른 같은 아이디",
);
assert.equal((await db.doc(`phoneVerifications/${limitedProof.split(".")[0]}`).get()).get("usedAt"), null, "한도면 증표 소비 안 함");

// --- 성공: 승인 대기 학부모 — 잠금·다른 세션 준비 ---
for (let i = 0; i < 6; i += 1) {
  await call("signInParent", { loginId: "findpv", password: "wrong-pw" }).catch(() => undefined);
}
await assert.rejects(call("signInParent", { loginId: "findpv", password: "pw123456" }), /잠시 잠겼습니다/);
const otherApp = initializeApp(config, "other-device");
const otherAuth = getAuth(otherApp);
connectAuthEmulator(otherAuth, "http://127.0.0.1:9099", { disableWarnings: true });
await signInWithCustomToken(otherAuth, await adminAuth().createCustomToken(pv));
await otherAuth.currentUser.reload();
await sleep(1100);
const claimsBefore = (await adminAuth().getUser(pv)).customClaims;
const statusBefore = (await db.doc(`academies/${A1}/parents/${pv}`).get()).get("status");
assert.equal(statusBefore, "pending_approval");

const pvProof = await resetProof(X);
const v1 = await call("verifyPasswordResetTarget", { loginId: " FindPV ", phone: X, phoneProof: pvProof });
assert.equal(v1.status, "ok");
assert.match(v1.ticket, /^[A-Za-z0-9_-]{27}\.[A-Za-z0-9_-]{43}$/);
await assert.rejects(
  call("verifyPasswordResetTarget", { loginId: "findpv", phone: X, phoneProof: pvProof }), /번호 확인을 다시/, "증표 1회",
);
await assert.rejects(call("resetPasswordWithPhone", { ticket: v1.ticket, newPassword: "12345" }), /6자 이상/);
const done = await call("resetPasswordWithPhone", { ticket: v1.ticket, newPassword: "newpw789" });
assert.deepEqual(done, { status: "ok", role: "parent", loginId: "findpv" });
assert.deepEqual(await call("resetPasswordWithPhone", { ticket: v1.ticket, newPassword: "again999" }), { status: "expired" }, "표 1회");
assert.deepEqual(await call("resetPasswordWithPhone", { ticket: "garbage", newPassword: "again999" }), { status: "expired" });

await assert.rejects(call("signInParent", { loginId: "findpv", password: "pw123456" }), /올바르지 않습니다/, "옛 비밀번호");
const relogin = await call("signInParent", { loginId: "findpv", password: "newpw789" });
assert.ok(relogin.customToken, "새 비밀번호 + 잠금 해제");
await assert.rejects(otherAuth.currentUser.reload(), /user-token-expired|TOKEN_EXPIRED/i, "다른 세션 끊김");
// B3 — 상태·클레임 그대로(승인 대기 계정이 재설정으로 활성되지 않음)
assert.equal((await db.doc(`academies/${A1}/parents/${pv}`).get()).get("status"), "pending_approval");
assert.equal(relogin.membershipStatus, "pending_approval");
assert.deepEqual((await adminAuth().getUser(pv)).customClaims, claimsBefore);
const pvDoc = (await db.doc(`academies/${A1}/parents/${pv}`).get()).data();
assert.equal(pvDoc.passwordResetVia, "phone");
assert.ok(pvDoc.passwordResetAt);
const secret = (await db.doc(`academies/${A1}/parents/${pv}/secrets/login`).get()).data();
assert.equal(secret.loginFailures, 0);
assert.equal(secret.loginLockedUntil, undefined);
const bell = await db.doc(`academies/${A1}/adminInbox/pw-reset-${pv}`).get();
assert.equal(bell.get("kind"), "member_password_reset");
assert.equal(bell.get("entityType"), "parent");
assert.ok(bell.get("expiresAt"));
assert.ok(!/01\d{8,9}|010-/.test(JSON.stringify(bell.data())), "벨에 번호 없음");

// --- 성공: 가입 승인 대기 직원(B3) ---
const svClaims = (await adminAuth().getUser(sv)).customClaims;
assert.equal(svClaims.membershipStatus, "pending_registration");
const v2 = await call("verifyPasswordResetTarget", { loginId: "findsv", phone: X, phoneProof: await resetProof(X) });
assert.equal(v2.status, "ok");
assert.deepEqual(await call("resetPasswordWithPhone", { ticket: v2.ticket, newPassword: "staffnew1" }), {
  status: "ok", role: "teacher", loginId: "findsv",
});
assert.equal((await db.doc(`academies/${A2}/staff/${sv}`).get()).get("status"), "pending_registration");
assert.deepEqual((await adminAuth().getUser(sv)).customClaims, svClaims);
assert.equal((await call("signInTeacher", { loginId: "findsv", password: "staffnew1" })).membershipStatus, "pending_registration");
assert.equal((await db.doc(`academies/${A2}/adminInbox/pw-reset-${sv}`).get()).get("entityType"), "teacher");

// --- 표 만료·표를 받은 뒤 계정이 바뀜 ---
const v3 = await call("verifyPasswordResetTarget", { loginId: "findsv", phone: X, phoneProof: await resetProof(X) });
await db.doc(`phoneVerifications/${v3.ticket.split(".")[0]}`).update({ resetTicketExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
assert.deepEqual(await call("resetPasswordWithPhone", { ticket: v3.ticket, newPassword: "zzzzzz1" }), { status: "expired" });
const v4 = await call("verifyPasswordResetTarget", { loginId: "findsv", phone: X, phoneProof: await resetProof(X) });
assert.equal(v4.status, "ok");
await db.doc(`academies/${A2}/staff/${sv}`).update({ phone: "010-6100-0055" });
assert.deepEqual(await call("resetPasswordWithPhone", { ticket: v4.ticket, newPassword: "zzzzzz3" }), { status: "no_match" }, "표를 받은 뒤 번호가 바뀜");
const v5 = await call("verifyPasswordResetTarget", { loginId: "findpv", phone: X, phoneProof: await resetProof(X) });
assert.equal(v5.status, "ok");
await db.doc(`academies/${A1}/parents/${pv}`).update({ status: "inactive" });
assert.deepEqual(await call("resetPasswordWithPhone", { ticket: v5.ticket, newPassword: "zzzzzz2" }), { status: "no_match" });
assert.equal((await call("signInParent", { loginId: "findpv", password: "newpw789" })).membershipStatus, "inactive", "비밀번호 그대로");

await clearIssueCounters();
console.log("SMOKE OK account-recovery");
process.exit(0);
