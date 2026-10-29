/**
 * 로그인 ID 비밀번호 흐름 통합 스모크 — `npm run test:functions` (Auth·Firestore·Functions 에뮬레이터)
 * secrets/login에 평문이 남지 않는지, 로그인·첫 로그인·비밀번호 변경·임시 비밀번호 재발급·학부모 자가 가입이
 * 해시 기준으로 동작하는지, 승인 대기 계정이 첫 로그인 함수로 스스로 활성화하지 못하는지 확인한다.
 */
import assert from "node:assert/strict";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A = "o3_a1";

const owner = await adminAuth().createUser({ email: "owner3@t.dev", password: "pass1234", emailVerified: true });
await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "비밀번호 학원", status: "active" });

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);

/** secrets/login에 평문 필드·평문 값이 없고 해시 형식만 있는지 */
async function assertNoPlaintext(path, ...plains) {
  const data = (await db.doc(path).get()).data() ?? {};
  assert.equal("password" in data, false, `${path}: password 평문 필드`);
  assert.equal("tempPassword" in data, false, `${path}: tempPassword 평문 필드`);
  const json = JSON.stringify(data);
  for (const p of plains) assert.equal(json.includes(p), false, `${path}: 평문 값 포함`);
  return data;
}

async function loginTeacher(loginId, password) {
  const res = await call("signInTeacher", { loginId, password });
  await signInWithCustomToken(auth, res.customToken);
  return res;
}

// --- 초대 링크 가입: 본인 비밀번호는 해시로만 ---
await signInWithEmailAndPassword(auth, "owner3@t.dev", "pass1234");
await call("listAcademyRoles", { academyId: A });
const invite = await call("createStaffInvite", { academyId: A, displayName: "링크 가입자", roleId: "teacher" });
await signOut(auth);
const token = new URL(invite.url).searchParams.get("token");
await call("acceptStaffInvite", { token, method: "password", loginId: "linkjoiner", password: "linkpass1" });
const linkUid = (await db.collection(`academies/${A}/staff`).where("loginId", "==", "linkjoiner").get()).docs[0].id;
const linkSecret = await assertNoPlaintext(`academies/${A}/staff/${linkUid}/secrets/login`, "linkpass1");
assert.equal(linkSecret.passwordHash.algo, "scrypt");
await assert.rejects(call("signInTeacher", { loginId: "linkjoiner", password: "wrongpass" }), /올바르지 않습니다/);

// 승인 대기 계정은 첫 로그인 함수로 스스로 활성화할 수 없음
await loginTeacher("linkjoiner", "linkpass1");
await assert.rejects(call("completeMemberFirstLogin", { newPassword: "selfactive1" }), /첫 로그인/);
assert.equal((await db.doc(`academies/${A}/staff/${linkUid}`).get()).get("status"), "pending_registration");
await signOut(auth);

// --- 직접 만든 계정: 임시 비밀번호 해시 → 첫 로그인으로 본인 비밀번호 ---
await signInWithEmailAndPassword(auth, "owner3@t.dev", "pass1234");
const { accounts } = await call("createStaffAccounts", { academyId: A, items: [{ displayName: "직접 직원", roleId: "teacher" }] });
const acct = accounts[0];
const secretPath = `academies/${A}/staff/${acct.authUid}/secrets/login`;
const tempSecret = await assertNoPlaintext(secretPath, acct.tempPassword);
assert.ok(tempSecret.tempPasswordHash && !tempSecret.passwordHash);

// 임시 비밀번호 재발급 — 새 것만 통과, 이전 것은 실패
const reissued = await call("regenerateMemberTempPassword", { academyId: A, memberAuthUid: acct.authUid, role: "teacher" });
assert.notEqual(reissued.tempPassword, acct.tempPassword);
await assertNoPlaintext(secretPath, acct.tempPassword, reissued.tempPassword);
await signOut(auth);
await assert.rejects(call("signInTeacher", { loginId: acct.loginId, password: acct.tempPassword }), /올바르지 않습니다/);

const first = await loginTeacher(acct.loginId, reissued.tempPassword);
assert.equal(first.membershipStatus, "pending_setup");
await call("completeMemberFirstLogin", { newPassword: "myown123" });
const afterFirst = await assertNoPlaintext(secretPath, "myown123", reissued.tempPassword);
assert.ok(afterFirst.passwordHash && !afterFirst.tempPasswordHash, "첫 로그인 후 임시 비밀번호 해시 삭제");
assert.equal((await db.doc(`academies/${A}/staff/${acct.authUid}`).get()).get("status"), "active");
await signOut(auth);
await assert.rejects(call("signInTeacher", { loginId: acct.loginId, password: reissued.tempPassword }), /올바르지 않습니다/);

// --- 비밀번호 변경 ---
await loginTeacher(acct.loginId, "myown123");
await assert.rejects(call("updateTeacherPassword", { currentPassword: "wrong999", newPassword: "changed1" }), /현재 비밀번호/);
await call("updateTeacherPassword", { currentPassword: "myown123", newPassword: "changed1" });
await assertNoPlaintext(secretPath, "myown123", "changed1");
await signOut(auth);
await assert.rejects(call("signInTeacher", { loginId: acct.loginId, password: "myown123" }), /올바르지 않습니다/);
await loginTeacher(acct.loginId, "changed1");
await signOut(auth);

// 활성 계정은 임시 비밀번호 재발급 불가
await signInWithEmailAndPassword(auth, "owner3@t.dev", "pass1234");
await assert.rejects(
  call("regenerateMemberTempPassword", { academyId: A, memberAuthUid: acct.authUid, role: "teacher" }),
  /첫 로그인 전 계정만/,
);
await signOut(auth);

// --- 학부모 자가 가입 ---
await call("registerParentSelfSignup", {
  academyId: A, loginId: "parentself", displayName: "학부모", password: "parentpw1",
  phone: "010-1111-2222", contactEmail: "p@t.dev", agreeTerms: true,
});
const parentUid = (await db.collection(`academies/${A}/parents`).where("loginId", "==", "parentself").get()).docs[0].id;
await assertNoPlaintext(`academies/${A}/parents/${parentUid}/secrets/login`, "parentpw1");
const parentLogin = await call("signInParent", { loginId: "parentself", password: "parentpw1" });
assert.ok(parentLogin.customToken);
await assert.rejects(call("signInParent", { loginId: "parentself", password: "parentpw2" }), /올바르지 않습니다/);

console.log("SMOKE OK (member passwords)");
process.exit(0);
