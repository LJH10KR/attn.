/**
 * 가입 QR 링크(2-K) 통합 스모크 — `npm run test:functions`
 * 링크 권한·지연 생성(동시 2회)·모든 가입 함수의 토큰 검사(없음·예전 academyId·형식·다시 만든 뒤 옛 토큰·꺼짐·종류 다름·archived)·
 * 다시 만들기·켜기/끄기·시간당 한도(학부모 100·직원 20) 경계와 원장 벨 한 번.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { CONSENTS } from "./_signup-token.mjs";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A = "o11_a1";
const B = "o11_a2";

const owner = await adminAuth().createUser({ email: "owner11@t.dev", password: "pass1234", emailVerified: true });
const parentsStaff = await adminAuth().createUser({ email: "parents11@t.dev", password: "pass1234" });
const membersStaff = await adminAuth().createUser({ email: "members11@t.dev", password: "pass1234" });
const plainStaff = await adminAuth().createUser({ email: "plain11@t.dev", password: "pass1234" });
await adminAuth().createUser({ email: "someone11@t.dev", password: "pass1234" });
await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "링크 학원", status: "active" });
await db.doc(`academies/${B}`).set({ ownerUid: owner.uid, name: "동시 학원", status: "active" });
const staffDoc = (uid, permissions) =>
  db.doc(`academies/${A}/staff/${uid}`).set({ authUid: uid, displayName: uid, status: "active", roleId: "custom", permissions });
await staffDoc(parentsStaff.uid, ["operations.parents"]);
await staffDoc(membersStaff.uid, ["settings.members"]);
await staffDoc(plainStaff.uid, []);

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);
const as = async (email) => {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, email, "pass1234");
};
const sha = (t) => createHash("sha256").update(t).digest("hex");
const seoulHourKey = (ms) => {
  const d = new Date(ms + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`;
};

const INVALID = /가입 링크가 올바르지 않거나 더 이상 쓸 수 없습니다/;
const OFF = /지금은 이 학원 가입을 받지 않습니다/;
const ARCHIVED = /이 학원은 현재 가입을 받지 않습니다/;
const LIMITED = /가입 요청이 많아 잠시 멈췄습니다/;

let seq = 0;
const parentInput = () => {
  seq += 1;
  return {
    loginId: `plink${seq}`, displayName: `학부모${seq}`, password: "pw123456",
    phone: "010-1111-2222", consents: CONSENTS,
  };
};
const staffInput = () => {
  seq += 1;
  return { consents: CONSENTS, method: "password", displayName: `직원${seq}`, phone: "010-2222-3333", loginId: `slink${seq}`, password: "pw123456" };
};

/** 학부모 5개 + 직원 3개 함수가 이 입력으로 모두 거부되는지(로그인한 일반 계정으로 — Google 함수는 로그인 확인 다음 토큰 검사) */
async function assertAllRejected(tokenPart, re, label) {
  await as("someone11@t.dev");
  const cases = [
    ["getParentSignupAcademyInfo", { ...tokenPart }],
    ["checkParentLoginIdAvailable", { ...tokenPart, loginId: "anyfree1" }],
    ["getParentSignupGoogleStatus", { ...tokenPart }],
    ["registerParentGoogleSignup", { ...tokenPart, displayName: "구글", phone: "010-1234-5678", consents: CONSENTS }],
    ["registerParentSelfSignup", { ...tokenPart, ...parentInput() }],
    ["getStaffSignupInfo", { ...tokenPart }],
    ["checkStaffSignupLoginId", { ...tokenPart, loginId: "anyfree2" }],
    ["registerStaffSignup", { ...tokenPart, ...staffInput() }],
  ];
  for (const [fn, data] of cases) {
    await assert.rejects(call(fn, data), re, `${label}: ${fn}`);
  }
  await signOut(auth);
}

// --- 링크 권한: 원장 둘 다, 학부모 관리 직원은 학부모 링크만, 멤버 직원은 직원 링크만, 권한 없는 직원은 모두 거부 ---
await as("owner11@t.dev");
const p1 = await call("getSignupLink", { academyId: A, kind: "parent" });
const s1 = await call("getSignupLink", { academyId: A, kind: "staff" });
assert.match(p1.token, /^[A-Za-z0-9_-]{43}$/);
assert.equal(p1.enabled, true);
assert.notEqual(p1.token, s1.token);
assert.equal((await call("getSignupLink", { academyId: A, kind: "parent" })).token, p1.token, "다시 불러도 같은 토큰");
assert.equal((await db.doc(`signupLinks/${sha(p1.token)}`).get()).get("academyId"), A);
assert.equal((await db.doc(`academies/${A}/secrets/signupLinks`).get()).get("parent.token"), p1.token);

await as("parents11@t.dev");
assert.equal((await call("getSignupLink", { academyId: A, kind: "parent" })).token, p1.token);
await assert.rejects(call("getSignupLink", { academyId: A, kind: "staff" }), /권한/);
await assert.rejects(call("regenerateSignupLink", { academyId: A, kind: "staff" }), /권한/);
await as("members11@t.dev");
assert.equal((await call("getSignupLink", { academyId: A, kind: "staff" })).token, s1.token);
await assert.rejects(call("getSignupLink", { academyId: A, kind: "parent" }), /권한/);
await assert.rejects(call("setSignupLinkEnabled", { academyId: A, kind: "parent", enabled: false }), /권한/);
await as("plain11@t.dev");
for (const kind of ["parent", "staff"]) {
  await assert.rejects(call("getSignupLink", { academyId: A, kind }), /권한/);
  await assert.rejects(call("regenerateSignupLink", { academyId: A, kind }), /권한/);
  await assert.rejects(call("setSignupLinkEnabled", { academyId: A, kind, enabled: false }), /권한/);
}

// --- 지연 생성 동시 2회 → 같은 토큰, 해시 문서 1개 ---
await as("owner11@t.dev");
const [c1, c2] = await Promise.all([
  call("getSignupLink", { academyId: B, kind: "parent" }),
  call("getSignupLink", { academyId: B, kind: "parent" }),
]);
assert.equal(c1.token, c2.token, "동시 첫 호출도 같은 토큰");
const bHashes = await db.collection("signupLinks").where("academyId", "==", B).where("kind", "==", "parent").get();
assert.equal(bHashes.size, 1, "해시 문서 1개");

// --- 정상 토큰: 조회 함수 통과 ---
await signOut(auth);
assert.equal((await call("getParentSignupAcademyInfo", { token: p1.token })).name, "링크 학원");
assert.equal((await call("getStaffSignupInfo", { token: s1.token })).academyName, "링크 학원");
await call("checkParentLoginIdAvailable", { token: p1.token, loginId: "freeparent1" });
await call("checkStaffSignupLoginId", { token: s1.token, loginId: "freestaff1" });
const joined = await call("registerParentSelfSignup", { token: p1.token, ...parentInput() });
assert.equal(joined.academyId, A);

// --- 거부: 토큰 없음·예전 academyId·형식·종류 다름 ---
await assertAllRejected({}, INVALID, "토큰 없음");
await assertAllRejected({ academyId: A }, INVALID, "예전 academyId 주소");
await assertAllRejected({ token: "o11_a1" }, INVALID, "형식 틀림");
await assertAllRejected({ token: "x".repeat(43) }, INVALID, "없는 토큰");
await assert.rejects(call("getStaffSignupInfo", { token: p1.token }), INVALID, "학부모 토큰으로 직원 가입");
await assert.rejects(call("getParentSignupAcademyInfo", { token: s1.token }), INVALID, "직원 토큰으로 학부모 가입");
await assert.rejects(call("registerStaffSignup", { consents: CONSENTS, token: p1.token, ...staffInput() }), INVALID);

// --- 끄기 → 모두 거부("가입을 받지 않음"), 켜기 → 같은 토큰으로 다시 통과 ---
await as("owner11@t.dev");
const off = await call("setSignupLinkEnabled", { academyId: A, kind: "parent", enabled: false });
assert.equal(off.enabled, false);
assert.equal(off.token, p1.token, "끄기는 토큰을 바꾸지 않음");
await signOut(auth);
for (const [fn, data] of [
  ["getParentSignupAcademyInfo", {}],
  ["checkParentLoginIdAvailable", { loginId: "offcheck1" }],
  ["registerParentSelfSignup", parentInput()],
]) {
  await assert.rejects(call(fn, { token: p1.token, ...data }), OFF, `꺼짐: ${fn}`);
}
await as("owner11@t.dev");
await call("setSignupLinkEnabled", { academyId: A, kind: "parent", enabled: true });
await signOut(auth);
await call("getParentSignupAcademyInfo", { token: p1.token });

// --- archived 학원 ---
await db.doc(`academies/${A}`).update({ status: "archived" });
await assert.rejects(call("getParentSignupAcademyInfo", { token: p1.token }), ARCHIVED);
await assert.rejects(call("registerStaffSignup", { consents: CONSENTS, token: s1.token, ...staffInput() }), ARCHIVED);
await db.doc(`academies/${A}`).update({ status: "active" });

// --- 한도: 학부모 100 ---
const W = seoulHourKey(Date.now());
const pHashRef = db.doc(`signupLinks/${sha(p1.token)}`);
await pHashRef.update({ rate: { windowKey: W, count: 99, notifiedWindowKey: null } });
await call("registerParentSelfSignup", { token: p1.token, ...parentInput() }); // 100번째
assert.equal((await pHashRef.get()).get("rate.count"), 100);
await assert.rejects(call("registerParentSelfSignup", { token: p1.token, ...parentInput() }), LIMITED, "101번째");
await assert.rejects(call("registerParentSelfSignup", { token: p1.token, ...parentInput() }), LIMITED, "102번째");
const parentBells = await db.collection(`academies/${A}/adminInbox`).where("kind", "==", "signup_rate_limited").get();
assert.equal(parentBells.size, 1, "벨은 한 번만");
assert.equal(parentBells.docs[0].id, `signup-limit-parent-${W}`);
assert.equal(parentBells.docs[0].get("linkKind"), "parent");
// 입력이 틀린 요청은 세지 않음(입력 검사 뒤에 셈) — 한도 상태여도 입력 오류 문구
await assert.rejects(call("registerParentSelfSignup", { token: p1.token, ...parentInput(), phone: "12" }), /휴대폰|전화번호/);
// 지난 창이면 다시 허용
await pHashRef.update({ rate: { windowKey: "2000010100", count: 100, notifiedWindowKey: "2000010100" } });
await call("registerParentSelfSignup", { token: p1.token, ...parentInput() });
assert.equal((await pHashRef.get()).get("rate.count"), 1);

// --- 한도: 직원 20 ---
const sHashRef = db.doc(`signupLinks/${sha(s1.token)}`);
await sHashRef.update({ rate: { windowKey: W, count: 19, notifiedWindowKey: null } });
await call("registerStaffSignup", { consents: CONSENTS, token: s1.token, ...staffInput() }); // 20번째
await assert.rejects(call("registerStaffSignup", { consents: CONSENTS, token: s1.token, ...staffInput() }), LIMITED, "21번째");
await assert.rejects(call("registerStaffSignup", { consents: CONSENTS, token: s1.token, ...staffInput() }), LIMITED, "22번째");
const staffBells = await db
  .collection(`academies/${A}/adminInbox`)
  .where("kind", "==", "signup_rate_limited")
  .where("linkKind", "==", "staff")
  .get();
assert.equal(staffBells.size, 1);

// --- 다시 만들기: 옛 토큰 무효, 새 토큰 통과, 켜짐 상태 이어받음, 카운터 0, 그 종류 벨 삭제 ---
await as("owner11@t.dev");
await call("setSignupLinkEnabled", { academyId: A, kind: "staff", enabled: false });
const s2 = await call("regenerateSignupLink", { academyId: A, kind: "staff" });
assert.notEqual(s2.token, s1.token);
assert.equal(s2.enabled, false, "꺼진 상태를 이어받음");
assert.equal((await sHashRef.get()).exists, false, "이전 해시 문서 삭제");
assert.equal((await db.doc(`signupLinks/${sha(s2.token)}`).get()).get("rate.count"), 0);
const leftStaffBells = await db
  .collection(`academies/${A}/adminInbox`)
  .where("kind", "==", "signup_rate_limited")
  .where("linkKind", "==", "staff")
  .get();
assert.equal(leftStaffBells.size, 0, "직원 링크 한도 벨 삭제");
assert.equal(
  (await db.collection(`academies/${A}/adminInbox`).where("linkKind", "==", "parent").get()).size,
  1,
  "학부모 링크 벨은 그대로",
);
await call("setSignupLinkEnabled", { academyId: A, kind: "staff", enabled: true });
const p2 = await call("regenerateSignupLink", { academyId: A, kind: "parent" });
await signOut(auth);
await assertAllRejected({ token: p1.token }, INVALID, "다시 만든 뒤 옛 학부모 토큰");
await assert.rejects(call("getStaffSignupInfo", { token: s1.token }), INVALID, "다시 만든 뒤 옛 직원 토큰");
await call("getParentSignupAcademyInfo", { token: p2.token });
await call("registerStaffSignup", { consents: CONSENTS, token: s2.token, ...staffInput() });

// --- 링크 문서·원문은 학원 삭제(원장)와 함께 정리 ---
await as("owner11@t.dev");
await call("deleteOwnerAcademy", { academyId: B });
assert.equal((await db.doc(`signupLinks/${sha(c1.token)}`).get()).exists, false);
assert.equal((await db.doc(`academies/${B}/secrets/signupLinks`).get()).exists, false);

console.log("SMOKE OK (signup links)");
process.exit(0);
