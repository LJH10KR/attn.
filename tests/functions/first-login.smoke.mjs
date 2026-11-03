/**
 * 첫 로그인 세션 스모크(2-H) — `npm run test:functions` (Auth·Firestore·Functions 에뮬레이터)
 * 직접 만든 직원·학부모 계정의 첫 로그인(`completeMemberFirstLogin`)이
 * ① 응답의 새 커스텀 토큰으로 다시 로그인한 세션은 토큰 갱신·Firestore 읽기가 되고
 * ② 첫 로그인 전에 임시 비밀번호로 만든 다른 세션은 토큰 갱신이 거부되며
 * ③ 다시 호출하면 failed-precondition, ④ 새 비밀번호로 로그인되는지 확인한다.
 */
import assert from "node:assert/strict";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb } from "firebase-admin/firestore";
import { deleteApp, initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { connectFirestoreEmulator, doc, getDoc, getFirestore } from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A = "o9_a1";

const owner = await adminAuth().createUser({ email: "owner9@t.dev", password: "pass1234", emailVerified: true });
await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "첫 로그인 학원", status: "active" });
await db.doc(`academies/${A}/meta/seq`).set({ nextTeacherSeq: 1, nextParentSeq: 1, nextStudentSeq: 1 });
await db.doc(`academies/${A}/meta/options`).set({ guardianRelations: [{ id: "mother", label: "어머니" }] });

let appSeq = 0;
/** 기기 하나 = 클라이언트 앱 하나(세션이 서로 독립) */
function device() {
  const app = initializeApp({ projectId: PROJECT, apiKey: "fake" }, `device-${++appSeq}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const fns = getFunctions(app, "asia-northeast3");
  connectFunctionsEmulator(fns, "127.0.0.1", 5001);
  const fs = getFirestore(app);
  connectFirestoreEmulator(fs, "127.0.0.1", 8080);
  const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);
  return { app, auth, fs, call };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ownerDevice = device();
await signInWithEmailAndPassword(ownerDevice.auth, "owner9@t.dev", "pass1234");

/** 임시 비밀번호로 로그인한 기기 */
async function memberDevice(role, loginId, password) {
  const d = device();
  const res = await d.call(role === "teacher" ? "signInTeacher" : "signInParent", { loginId, password });
  await signInWithCustomToken(d.auth, res.customToken);
  return d;
}

async function checkFirstLogin(role, account, memberPath) {
  const label = role === "teacher" ? "직원" : "학부모";
  // 다른 기기 — 계정을 만든 사람이 임시 비밀번호로 먼저 로그인해 둔 세션
  const other = await memberDevice(role, account.loginId, account.tempPassword);
  await other.auth.currentUser.reload();
  const before = await adminAuth().getUser(account.authUid);
  // 폐기 판단이 초 단위라 같은 초에 만든 세션은 살아남는다 — 실제로는 앞서 만든 세션
  await sleep(1100);

  const me = await memberDevice(role, account.loginId, account.tempPassword);
  const res = await me.call("completeMemberFirstLogin", { newPassword: "newpass99" });
  assert.equal(typeof res.customToken, "string", `${label}: 응답에 새 토큰`);
  assert.ok(res.customToken.length > 20);

  const after = await adminAuth().getUser(account.authUid);
  assert.ok(
    Date.parse(after.tokensValidAfterTime) > Date.parse(before.tokensValidAfterTime ?? 0),
    `${label}: 세션 폐기 시각 갱신(revokeRefreshTokens)`,
  );

  // ① 새 토큰으로 다시 로그인한 세션 — 계정 조회(폐기 검사)·갱신·본인 문서 읽기 성공
  await signInWithCustomToken(me.auth, res.customToken);
  await me.auth.currentUser.reload();
  const refreshed = await me.auth.currentUser.getIdTokenResult(true);
  assert.equal(refreshed.claims.role, role);
  assert.equal(refreshed.claims.academyId, A);
  if (role === "teacher") {
    assert.equal(res.membershipStatus, "active");
    assert.equal(refreshed.claims.membershipStatus, "active", "직원 토큰 클레임 = 전환 뒤 상태");
  }
  const mine = await getDoc(doc(me.fs, memberPath(account.authUid)));
  assert.equal(mine.exists(), true, `${label}: 새 세션으로 본인 문서 읽기`);
  assert.equal(mine.get("status"), res.membershipStatus);

  // ② 첫 로그인 전에 만든 다른 세션 — 폐기된 토큰이라 거부(에뮬레이터는 토큰 갱신이 아니라 계정 조회에서 폐기를 검사,
  //    운영 백엔드는 갱신 자체도 거부). 앱을 다시 열 때(`/` 복원)의 계정 조회와 같은 경로
  await assert.rejects(other.auth.currentUser.reload(), /user-token-expired|TOKEN_EXPIRED/i, `${label}: 다른 세션 끊김`);

  // ③ 다시 호출하면 거부(이미 설정됨)
  await assert.rejects(
    me.call("completeMemberFirstLogin", { newPassword: "another99" }),
    /첫 로그인 비밀번호 설정이 필요한 계정이 아닙니다/,
  );

  // ④ 새 비밀번호로 로그인, 임시 비밀번호는 무효
  await signOut(me.auth);
  const again = await memberDevice(role, account.loginId, "newpass99");
  await again.auth.currentUser.reload();
  await assert.rejects(
    me.call(role === "teacher" ? "signInTeacher" : "signInParent", {
      loginId: account.loginId,
      password: account.tempPassword,
    }),
    /로그인 ID 또는 비밀번호가 올바르지 않습니다/,
  );
  for (const d of [other, me, again]) await deleteApp(d.app);
}

// --- 직원 ---
await ownerDevice.call("listAcademyRoles", { academyId: A });
const staffMade = await ownerDevice.call("createStaffAccounts", {
  academyId: A,
  items: [{ displayName: "첫 로그인 선생님", roleId: "lessonManager" }],
});
assert.equal(staffMade.accounts.length, 1);
await checkFirstLogin("teacher", staffMade.accounts[0], (uid) => `academies/${A}/staff/${uid}`);

// --- 학부모 ---
const sid = (
  await ownerDevice.call("saveStudent", {
    academyId: A, name: "첫 자녀", grade: "e3", status: "enrolled",
    guardians: [{ relationId: "mother", name: "엄마", phone: "010-4444-5555" }],
  })
).studentId;
const parentMade = await ownerDevice.call("createParentAccount", {
  academyId: A, displayName: "첫 로그인 엄마", phone: "010-4444-5555", studentIds: [sid],
});
assert.equal(parentMade.linked.length, 1);
await checkFirstLogin(
  "parent",
  { loginId: parentMade.loginId, tempPassword: parentMade.tempPassword, authUid: parentMade.authUid },
  (uid) => `academies/${A}/parents/${uid}`,
);

console.log("SMOKE OK");
process.exit(0);
