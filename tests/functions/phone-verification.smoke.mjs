/**
 * 휴대폰 번호 확인(OCTOMO, 2-L) 통합 스모크 — `npm run test:functions`(에뮬레이터 = 가짜 OCTOMO, 번호 끝 4자리 규칙).
 * 코드 발급(토큰·010 아님)·조회 → 증표·코드 소비(재조회 거부)·증표 1회만(재사용·번호·목적·링크 다름 거부),
 * 문자 없음 → 남은 횟수·5초 간격·코드당 3회, 만료, 429 → 그날 차단, 하루 전체 299 → 300 이후 unavailable → 건너뛰기 가입,
 * 링크별 150, 번호별 발급 제한, 번호 변경 목적(로그인 본인만), 증표 만료, 직원·Google 가입 증표, 원장 동의 기록·다시 묻기 상태.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
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
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { CONSENTS, seedSignupToken } from "./_signup-token.mjs";

const requireCjs = createRequire(import.meta.url);
const { counterKeys } = requireCjs("../../functions/lib/lib/phone-verification.js");

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A = "o12_a1";
const B = "o12_a2";

const owner = await adminAuth().createUser({ email: "owner12@t.dev", password: "pass1234", emailVerified: true });
for (const [id, name] of [[A, "번호 학원"], [B, "다른 학원"]]) {
  await db.doc(`academies/${id}`).set({ ownerUid: owner.uid, name, status: "active" });
  await db.doc(`academies/${id}/meta/seq`).set({ nextTeacherSeq: 1, nextParentSeq: 1, nextStudentSeq: 1 });
}
const P = await seedSignupToken(db, A, "parent");
const S = await seedSignupToken(db, A, "staff");
const PB = await seedSignupToken(db, B, "parent");

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);

const keysNow = (phoneKey = "", linkHash = null) =>
  counterKeys({ nowMs: Date.now(), phoneKey, ipHash: null, uid: null, linkHash });
const counter = (key) => db.doc(`phoneVerificationCounters/${key}`);
const verification = (id) => db.doc(`phoneVerifications/${id}`);
const linkHashOf = async (token) =>
  (await db.doc(`academies/${A}/secrets/signupLinks`).get()).get("parent").token === token
    ? (await db.doc(`academies/${A}/secrets/signupLinks`).get()).get("parent").tokenHash
    : null;

/** 같은 코드를 5초 기다리지 않고 다시 조회할 수 있게 마지막 조회 시각을 당긴다 */
const rewindLastCheck = (id) => verification(id).update({ lastCheckAt: Timestamp.fromMillis(Date.now() - 10_000) });

let n = 0;
const parentSignup = (extra) => {
  n += 1;
  return call("registerParentSelfSignup", {
    token: P, loginId: `pvsign${n}`, displayName: `학부모${n}`, password: "pw123456", consents: CONSENTS, ...extra,
  });
};

/** 발급 → 조회(가짜 OCTOMO true) → 증표 */
async function verify(phone, purpose = "parent_signup", token = P) {
  const s = await call("startPhoneVerification", { purpose, phone, ...(token ? { token } : {}) });
  assert.equal(s.status, "issued", `발급 ${phone}`);
  const c = await call("checkPhoneVerification", { verificationId: s.verificationId });
  assert.equal(c.status, "verified", `확인 ${phone}`);
  return { ...s, proof: c.proof };
}

// --- 발급: 토큰 없음·잘못된 토큰 거부, 010 아닌 번호 unsupported, 정상 발급(숫자 6자리·서버에만 저장) ---
await assert.rejects(call("startPhoneVerification", { purpose: "parent_signup", phone: "010-1000-0001" }), /가입 링크/);
await assert.rejects(call("startPhoneVerification", { purpose: "parent_signup", token: S, phone: "010-1000-0001" }), /가입 링크/);
await assert.rejects(call("startPhoneVerification", { purpose: "find_login_id", token: P, phone: "010-1000-0001" }), /목적/);
assert.equal((await call("startPhoneVerification", { purpose: "parent_signup", token: P, phone: "011-123-4567" })).status, "unsupported_phone");
const s1 = await call("startPhoneVerification", { purpose: "parent_signup", token: P, phone: "010-1000-0001" });
assert.equal(s1.status, "issued");
assert.match(s1.code, /^\d{6}$/);
assert.equal(s1.smsTo, "16663538");
const v1 = await verification(s1.verificationId).get();
assert.equal(v1.get("phoneKey"), "01010000001");
assert.equal(v1.get("code"), s1.code);
assert.equal(v1.get("purpose"), "parent_signup");
assert.equal(v1.get("status"), "pending");

// --- 조회 → 증표, 코드 소비(다시 눌러도 증표를 또 주지 않음) ---
const octomoBefore = (await counter(keysNow().octomoDay).get()).get("count") ?? 0;
const c1 = await call("checkPhoneVerification", { verificationId: s1.verificationId });
assert.equal(c1.status, "verified");
assert.match(c1.proof, /^[A-Za-z0-9_-]{27}\.[A-Za-z0-9_-]{43}$/);
assert.equal((await verification(s1.verificationId).get()).get("status"), "verified");
assert.ok(!(await verification(s1.verificationId).get()).get("proofHash").includes(c1.proof.split(".")[1]), "원문 저장 안 함");
assert.equal((await counter(keysNow().octomoDay).get()).get("count"), octomoBefore + 1, "OCTOMO 호출 1건");
await rewindLastCheck(s1.verificationId);
assert.equal((await call("checkPhoneVerification", { verificationId: s1.verificationId })).status, "exhausted");
await assert.rejects(call("checkPhoneVerification", { verificationId: "x".repeat(27) }), /확인 요청/);

// --- 증표로 가입 → 번호 확인됨·동의 기록, 증표 한 번만 ---
const joined = await parentSignup({ phone: "010-1000-0001", phoneProof: c1.proof });
assert.equal(joined.phoneVerified, true);
assert.equal(joined.membershipStatus, "pending_approval");
const pUid = (await db.doc(`attnLoginIndex/${joined.loginId}`).get()).get("authUid");
const pDoc = await db.doc(`academies/${A}/parents/${pUid}`).get();
assert.equal(pDoc.get("phoneVerifiedKey"), "01010000001");
assert.ok(pDoc.get("phoneVerifiedAt"));
assert.equal(pDoc.get("consents").privacy.version, CONSENTS.privacy);
const used = await verification(s1.verificationId).get();
assert.ok(used.get("usedAt"));
assert.equal(used.get("usedByUid"), pUid);
const before = (await adminAuth().listUsers()).users.length;
await assert.rejects(parentSignup({ phone: "010-1000-0001", phoneProof: c1.proof }), /번호 확인을 다시/);
assert.equal((await adminAuth().listUsers()).users.length, before, "쓸 수 없는 증표 — Auth 계정을 만들지 않음");
assert.equal((await db.doc(`attnLoginIndex/pvsign${n}`).get()).exists, false);

// --- 증표 번호·목적·링크가 다르면 거부 ---
const v2 = await verify("010-1000-0002");
await assert.rejects(parentSignup({ phone: "010-1000-0009", phoneProof: v2.proof }), /입력한 번호가 다릅니다/);
await assert.rejects(
  call("registerStaffSignup", {
    token: S, method: "password", displayName: "직원", phone: "010-1000-0002", loginId: "pvstaff0", password: "pw123456",
    consents: CONSENTS, phoneProof: v2.proof,
  }),
  /번호 확인을 다시/,
  "학부모 가입 증표로 직원 가입 불가",
);
await assert.rejects(
  call("registerParentSelfSignup", {
    token: PB, loginId: "pvother1", displayName: "다른 학원", password: "pw123456", phone: "010-1000-0002",
    consents: CONSENTS, phoneProof: v2.proof,
  }),
  /번호 확인을 다시/,
  "다른 가입 링크의 증표 불가",
);
// 증표 만료
await verification(v2.verificationId).update({ proofExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
await assert.rejects(parentSignup({ phone: "010-1000-0002", phoneProof: v2.proof }), /번호 확인을 다시/);
// 형식이 틀린 증표
await assert.rejects(parentSignup({ phone: "010-1000-0002", phoneProof: "garbage" }), /번호 확인을 다시/);
// 동의 없음·옛 버전
await assert.rejects(parentSignup({ phone: "010-1000-0002", consents: undefined }), /동의해 주세요/);
await assert.rejects(parentSignup({ phone: "010-1000-0002", consents: { terms: "old", privacy: "old" } }), /약관이 바뀌었습니다/);

// --- 문자 없음(끝자리 0000): 남은 횟수 → 5초 간격 → 코드당 3회 ---
const s3 = await call("startPhoneVerification", { purpose: "parent_signup", token: P, phone: "010-3000-0000" });
assert.deepEqual(await call("checkPhoneVerification", { verificationId: s3.verificationId }), { status: "not_found", remaining: 2 });
const soon = await call("checkPhoneVerification", { verificationId: s3.verificationId });
assert.equal(soon.status, "too_soon");
assert.ok(soon.retryAfterMs > 0 && soon.retryAfterMs <= 5000);
await rewindLastCheck(s3.verificationId);
assert.deepEqual(await call("checkPhoneVerification", { verificationId: s3.verificationId }), { status: "not_found", remaining: 1 });
await rewindLastCheck(s3.verificationId);
assert.deepEqual(await call("checkPhoneVerification", { verificationId: s3.verificationId }), { status: "exhausted" });
await rewindLastCheck(s3.verificationId);
assert.deepEqual(await call("checkPhoneVerification", { verificationId: s3.verificationId }), { status: "exhausted" });
assert.equal((await verification(s3.verificationId).get()).get("checkCount"), 3, "4번째는 OCTOMO를 부르지 않음");

// --- 만료 ---
const s4 = await call("startPhoneVerification", { purpose: "parent_signup", token: P, phone: "010-4000-0004" });
await verification(s4.verificationId).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1) });
assert.deepEqual(await call("checkPhoneVerification", { verificationId: s4.verificationId }), { status: "expired" });

// --- OCTOMO 오류(0500) → unavailable(1회 사용), 429(0429) → 그날 차단 ---
const s5 = await call("startPhoneVerification", { purpose: "parent_signup", token: P, phone: "010-5000-0500" });
assert.deepEqual(await call("checkPhoneVerification", { verificationId: s5.verificationId }), { status: "unavailable" });
assert.equal((await verification(s5.verificationId).get()).get("checkCount"), 1);
const s6 = await call("startPhoneVerification", { purpose: "parent_signup", token: P, phone: "010-6000-0429" });
assert.deepEqual(await call("checkPhoneVerification", { verificationId: s6.verificationId }), { status: "unavailable" });
const blocked = (await counter(keysNow().octomoDay).get()).get("blockedUntil");
assert.ok(blocked && blocked.toMillis() > Date.now(), "429 → 그날 끝까지 차단");
assert.deepEqual(
  await call("startPhoneVerification", { purpose: "parent_signup", token: P, phone: "010-6000-0001" }),
  { status: "unavailable" },
  "차단 중엔 발급도 안 함",
);
// 이미 받은 코드의 조회도 OCTOMO를 부르지 않음
const callsWhileBlocked = (await counter(keysNow().octomoDay).get()).get("count");
const s5b = await verification(s5.verificationId).get();
await rewindLastCheck(s5.verificationId);
assert.deepEqual(await call("checkPhoneVerification", { verificationId: s5.verificationId }), { status: "unavailable" });
assert.equal((await counter(keysNow().octomoDay).get()).get("count"), callsWhileBlocked);
assert.equal((await verification(s5.verificationId).get()).get("checkCount"), s5b.get("checkCount"));
await counter(keysNow().octomoDay).update({ blockedUntil: null });

// --- 하루 전체 한도: 299 → 300번째 허용 → 그 뒤 unavailable → 번호 확인 없이 가입(승인 대기) ---
await counter(keysNow().octomoDay).set({ count: 299 }, { merge: true });
const v300 = await verify("010-7000-0300");
assert.equal((await counter(keysNow().octomoDay).get()).get("count"), 300);
assert.deepEqual(
  await call("startPhoneVerification", { purpose: "parent_signup", token: P, phone: "010-7000-0301" }),
  { status: "unavailable" },
);
const skipped = await parentSignup({ phone: "010-7000-0301" });
assert.equal(skipped.phoneVerified, false);
assert.equal(skipped.membershipStatus, "pending_approval");
// 한도 직전에 받은 증표는 그대로 쓸 수 있음
assert.equal((await parentSignup({ phone: "010-7000-0300", phoneProof: v300.proof })).phoneVerified, true);
await counter(keysNow().octomoDay).set({ count: 0 }, { merge: true });

// --- 링크별 하루 150 ---
const pHash = await linkHashOf(P);
assert.ok(pHash);
await counter(keysNow("", pHash).linkDay).set({ count: 150 });
assert.deepEqual(
  await call("startPhoneVerification", { purpose: "parent_signup", token: P, phone: "010-8000-0001" }),
  { status: "unavailable" },
);
// 다른 링크(직원)는 그대로
assert.equal((await call("startPhoneVerification", { purpose: "staff_signup", token: S, phone: "010-8000-0001" })).status, "issued");
await counter(keysNow("", pHash).linkDay).delete();

// --- 번호별 발급 제한(시간당 5) ---
for (let i = 0; i < 4; i += 1) {
  assert.equal((await call("startPhoneVerification", { purpose: "parent_signup", token: P, phone: "010-8000-0001" })).status, "issued");
}
// 위 직원 링크 1건 + 4건 = 5건 → 6번째 거부
assert.deepEqual(
  await call("startPhoneVerification", { purpose: "parent_signup", token: P, phone: "010-8000-0001" }),
  { status: "unavailable" },
);

// --- 번호 변경 목적: 로그인한 학부모·직원 본인만, 남의 코드 조회 불가 ---
await assert.rejects(call("startPhoneVerification", { purpose: "phone_change", phone: "010-9000-0001" }), /로그인/);
await signOut(auth);
const login = await call("signInParent", { loginId: joined.loginId, password: "pw123456" });
await signInWithCustomToken(auth, login.customToken);
const pc = await call("startPhoneVerification", { purpose: "phone_change", phone: "010-9000-0001" });
assert.equal(pc.status, "issued");
assert.deepEqual((await verification(pc.verificationId).get()).get("scope"), { uid: pUid, academyId: A, role: "parent" });
await signOut(auth);
await signInWithEmailAndPassword(auth, "owner12@t.dev", "pass1234");
await assert.rejects(call("startPhoneVerification", { purpose: "phone_change", phone: "010-9000-0001" }), /학부모·직원/);
await assert.rejects(call("checkPhoneVerification", { verificationId: pc.verificationId }), /확인 요청/, "다른 계정은 조회 불가");
await signOut(auth);

// --- 직원 가입 증표 → 번호 확인됨·동의 기록 ---
const vs = await verify("010-9100-0001", "staff_signup", S);
const staffRes = await call("registerStaffSignup", {
  token: S, method: "password", displayName: "확인 직원", phone: "010-9100-0001", loginId: "pvstaff1", password: "pw123456",
  consents: CONSENTS, phoneProof: vs.proof,
});
assert.equal(staffRes.phoneVerified, true);
const sDoc = (await db.collection(`academies/${A}/staff`).where("loginId", "==", "pvstaff1").get()).docs[0];
assert.equal(sDoc.get("phoneVerifiedKey"), "01091000001");
assert.equal(sDoc.get("consents").terms.version, CONSENTS.terms);
assert.equal(sDoc.get("status"), "pending_registration");

// --- Google 학부모 가입 증표 ---
const gv = await verify("010-9200-0001");
await signOut(auth);
const cred = GoogleAuthProvider.credential(JSON.stringify({ sub: "pv-google-1", email: "pvg1@gmail.com", email_verified: true }));
const gUser = (await signInWithCredential(auth, cred)).user;
const gRes = await call("registerParentGoogleSignup", {
  token: P, displayName: "구글 학부모", phone: "010-9200-0001", consents: CONSENTS, phoneProof: gv.proof,
});
assert.equal(gRes.phoneVerified, true);
const gDoc = await db.doc(`academies/${A}/parents/${gUser.uid}`).get();
assert.equal(gDoc.get("phoneVerifiedKey"), "01092000001");
assert.equal(gDoc.get("consents").terms.version, CONSENTS.terms);
await signOut(auth);

// --- 원장 동의: 기록 없음 → 다시 묻기 상태, 기록 → 지금 버전 ---
await signInWithEmailAndPassword(auth, "owner12@t.dev", "pass1234");
assert.equal((await call("getOwnerConsentState", {})).current, false);
await assert.rejects(call("recordOwnerConsent", { consents: { terms: "old", privacy: CONSENTS.privacy } }), /약관이 바뀌었습니다/);
await call("recordOwnerConsent", { consents: CONSENTS });
assert.equal((await call("getOwnerConsentState", {})).current, true);
const oc = await db.doc(`legalConsents/${owner.uid}`).get();
assert.equal(oc.get("consents").terms.version, CONSENTS.terms);
assert.ok(oc.get("consents").terms.agreedAt);
// 문서 버전이 바뀐 것처럼 — 저장된 버전이 옛 값이면 다시 묻기
await db.doc(`legalConsents/${owner.uid}`).update({ "consents.terms.version": "older" });
assert.equal((await call("getOwnerConsentState", {})).current, false);
await signOut(auth);
await assert.rejects(call("getOwnerConsentState", {}), /로그인/);

console.log("SMOKE OK phone-verification");
process.exit(0);
