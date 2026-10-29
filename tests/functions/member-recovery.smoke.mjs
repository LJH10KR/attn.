/**
 * 계정 복구·보호 통합 스모크 — `npm run test:functions` (Auth·Firestore·Functions 에뮬레이터)
 * 계정 직접 만들기 부분 실패 시 성공분 반환, 활성 계정 비밀번호 초기화(상태·클레임·세션·권한 범위),
 * 로그인 ID 로그인 연속 실패 잠금·해제를 확인한다.
 */
import assert from "node:assert/strict";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb, Timestamp } from "firebase-admin/firestore";
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
const A = "o4_a1";
const WRONG = /로그인 ID 또는 비밀번호가 올바르지 않습니다/;

const owner = await adminAuth().createUser({ email: "owner4@t.dev", password: "pass1234", emailVerified: true });
const manager = await adminAuth().createUser({ email: "manager4@t.dev", password: "pass1234" });
await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "복구 학원", status: "active" });
await db.doc(`academies/${A}/staff/${manager.uid}`).set({
  authUid: manager.uid, displayName: "멤버 관리 직원", status: "active", roleId: "custom",
  permissions: ["settings.members", "operations.students"],
});

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);
const asOwner = () => signInWithEmailAndPassword(auth, "owner4@t.dev", "pass1234");
const staffDoc = (uid) => db.doc(`academies/${A}/staff/${uid}`);

async function loginTeacher(loginId, password) {
  const res = await call("signInTeacher", { loginId, password });
  await signInWithCustomToken(auth, res.customToken);
  return res;
}

/** 직접 만든 계정을 첫 로그인까지 마쳐 사용 중으로 */
async function activeTeacher(acct, password) {
  await signOut(auth);
  await loginTeacher(acct.loginId, acct.tempPassword);
  await call("completeMemberFirstLogin", { newPassword: password });
  await signOut(auth);
}

// --- 계정 직접 만들기: 중간 실패해도 성공분(임시 비밀번호 포함) 반환 ---
await asOwner();
await call("listAcademyRoles", { academyId: A });
const made = await call("createStaffAccounts", {
  academyId: A,
  items: [
    { displayName: "첫째", roleId: "teacher" },
    { staffId: manager.uid, roleId: "teacher" }, // 이미 계정이 있는 직원 → 실패
    { displayName: "셋째", roleId: "lessonManager" },
  ],
});
assert.equal(made.accounts.length, 2);
assert.deepEqual(made.accounts.map((a) => a.index), [0, 2]);
assert.ok(made.accounts.every((a) => a.loginId && a.tempPassword));
assert.equal(made.failures.length, 1);
assert.equal(made.failures[0].index, 1);
assert.match(made.failures[0].message, /이미 계정이 있는/);
const [first, third] = made.accounts;

// 범위 밖 권한은 입력 단계에서 전체 거부 — 직원 문서도 만들지 않음
await signOut(auth);
await signInWithEmailAndPassword(auth, "manager4@t.dev", "pass1234");
const before = (await db.collection(`academies/${A}/staff`).get()).size;
await assert.rejects(
  call("createStaffAccounts", { academyId: A, items: [{ displayName: "범위 밖", roleId: "superAdmin" }] }),
  /본인이 가진 권한까지만/,
);
assert.equal((await db.collection(`academies/${A}/staff`).get()).size, before);
// 전부 실패하면 오류
await assert.rejects(
  call("createStaffAccounts", { academyId: A, items: [{ staffId: manager.uid, roleId: "teacher" }] }),
  /이미 계정이 있는/,
);
await signOut(auth);

// --- 활성 계정 비밀번호 초기화 ---
await activeTeacher(first, "firstpw1");
const beforeReset = await adminAuth().getUser(first.authUid);
await asOwner();
// 첫 로그인 전·승인 대기·비활성 계정은 초기화 불가
await assert.rejects(
  call("resetMemberPassword", { academyId: A, memberAuthUid: third.authUid, role: "teacher" }),
  /사용 중인 계정만/,
);
const reset = await call("resetMemberPassword", { academyId: A, memberAuthUid: first.authUid, role: "teacher" });
assert.equal(reset.loginId, first.loginId);
assert.ok(reset.tempPassword);
assert.equal((await staffDoc(first.authUid).get()).get("status"), "pending_setup");
const secret = (await db.doc(`academies/${A}/staff/${first.authUid}/secrets/login`).get()).data();
assert.ok(secret.tempPasswordHash && !secret.passwordHash, "본인 비밀번호 해시 삭제");
assert.equal(JSON.stringify(secret).includes(reset.tempPassword), false, "임시 비밀번호 평문 미저장");
const afterReset = await adminAuth().getUser(first.authUid);
assert.equal(afterReset.customClaims?.membershipStatus, "pending_setup");
assert.ok(
  Date.parse(afterReset.tokensValidAfterTime) > Date.parse(beforeReset.tokensValidAfterTime),
  "기존 세션 무효화",
);
// 초기화 직후 다시 초기화 불가(이미 첫 로그인 전)
await assert.rejects(
  call("resetMemberPassword", { academyId: A, memberAuthUid: first.authUid, role: "teacher" }),
  /사용 중인 계정만/,
);
await signOut(auth);
await assert.rejects(call("signInTeacher", { loginId: first.loginId, password: "firstpw1" }), WRONG);
const relog = await loginTeacher(first.loginId, reset.tempPassword);
assert.equal(relog.membershipStatus, "pending_setup");
await call("completeMemberFirstLogin", { newPassword: "firstpw2" });
assert.equal((await staffDoc(first.authUid).get()).get("status"), "active");
await signOut(auth);

// 직원(settings.members): 본인·더 넓은 권한 직원 불가, 범위 안 직원 가능, 학부모는 operations.parents 필요
await asOwner();
await call("assignStaffRole", { academyId: A, staffId: first.authUid, roleId: "superAdmin" });
await signOut(auth);
await signInWithEmailAndPassword(auth, "manager4@t.dev", "pass1234");
await assert.rejects(
  call("resetMemberPassword", { academyId: A, memberAuthUid: first.authUid, role: "teacher" }),
  /넓은 권한/,
);
await assert.rejects(
  call("resetMemberPassword", { academyId: A, memberAuthUid: manager.uid, role: "teacher" }),
  /본인 계정/,
);
await signOut(auth);
await asOwner();
await call("assignStaffRole", { academyId: A, staffId: first.authUid, roleId: "teacher" });
await signOut(auth);
await signInWithEmailAndPassword(auth, "manager4@t.dev", "pass1234");
const byManager = await call("resetMemberPassword", { academyId: A, memberAuthUid: first.authUid, role: "teacher" });
assert.ok(byManager.tempPassword);
await signOut(auth);
await activeTeacher({ loginId: first.loginId, tempPassword: byManager.tempPassword }, "firstpw3");

// 학부모 — 자가 가입 후 사용 중 처리, 초기화는 operations.parents
await call("registerParentSelfSignup", {
  academyId: A, loginId: "parent4", displayName: "학부모", password: "parentpw1",
  phone: "010-3333-4444", contactEmail: "p4@t.dev", agreeTerms: true,
});
const parentUid = (await db.collection(`academies/${A}/parents`).where("loginId", "==", "parent4").get()).docs[0].id;
await db.doc(`academies/${A}/parents/${parentUid}`).update({ status: "active" });
await signInWithEmailAndPassword(auth, "manager4@t.dev", "pass1234");
await assert.rejects(
  call("resetMemberPassword", { academyId: A, memberAuthUid: parentUid, role: "parent" }),
  /권한이 없습니다/,
);
await signOut(auth);
await asOwner();
const parentReset = await call("resetMemberPassword", { academyId: A, memberAuthUid: parentUid, role: "parent" });
await signOut(auth);
await assert.rejects(call("signInParent", { loginId: "parent4", password: "parentpw1" }), WRONG);
const parentLogin = await call("signInParent", { loginId: "parent4", password: parentReset.tempPassword });
assert.equal(parentLogin.membershipStatus, "pending_setup");

// --- 로그인 연속 실패 잠금 ---
const lockSecret = db.doc(`academies/${A}/staff/${first.authUid}/secrets/login`);
// 없는 ID와 틀린 비밀번호는 같은 문구
await assert.rejects(call("signInTeacher", { loginId: "nobody-here", password: "whatever1" }), WRONG);
for (let i = 0; i < 5; i++) {
  await assert.rejects(call("signInTeacher", { loginId: first.loginId, password: `wrong${i}xx` }), WRONG);
}
// 6번째는 맞는 비밀번호여도 잠금
await assert.rejects(call("signInTeacher", { loginId: first.loginId, password: "firstpw3" }), /잠시 잠겼습니다/);
const locked = (await lockSecret.get()).data();
assert.ok(locked.loginLockedUntil instanceof Timestamp);
// 잠금 시간이 지나면(에뮬레이터에서는 시각을 과거로) 다시 로그인되고 횟수 초기화
await lockSecret.update({ loginLockedUntil: Timestamp.fromMillis(Date.now() - 1000) });
await loginTeacher(first.loginId, "firstpw3");
const unlocked = (await lockSecret.get()).data();
assert.equal(unlocked.loginFailures, 0);
assert.equal(unlocked.loginLockedUntil, undefined);
await signOut(auth);

// 성공 사이의 실패는 이어서 세지 않음
for (let i = 0; i < 4; i++) {
  await assert.rejects(call("signInTeacher", { loginId: first.loginId, password: `again${i}xx` }), WRONG);
}
await loginTeacher(first.loginId, "firstpw3");
await signOut(auth);
await assert.rejects(call("signInTeacher", { loginId: first.loginId, password: "again9xx" }), WRONG);

// 잠긴 계정도 관리자 비밀번호 초기화로 풀림
for (let i = 0; i < 6; i++) {
  await call("signInTeacher", { loginId: first.loginId, password: `lock${i}xx` }).catch(() => undefined);
}
await assert.rejects(call("signInTeacher", { loginId: first.loginId, password: "firstpw3" }), /잠시 잠겼습니다/);
await asOwner();
const unlockReset = await call("resetMemberPassword", { academyId: A, memberAuthUid: first.authUid, role: "teacher" });
await signOut(auth);
await loginTeacher(first.loginId, unlockReset.tempPassword);
await signOut(auth);

console.log("SMOKE OK (member recovery)");
process.exit(0);
