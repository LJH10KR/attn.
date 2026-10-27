/**
 * 로그인 ID 계정 보안 보강 통합 스모크 — `npm run test:functions` (Auth·Firestore·Functions 에뮬레이터)
 * - 내부 이메일 + 사용자 비밀번호로 Firebase Auth 직접 로그인(잠금 우회)이 모든 비밀번호 변경 경로 뒤에도 실패
 * - 없는 ID·다른 역할 ID·틀린 비밀번호의 응답(코드·문구) 동일
 * - 본인 재확인(reauthenticateMember)이 로그인과 같은 잠금을 공유
 * - 써 오던 계정 삭제 시 인사 기록 유지, 첫 로그인 전 계정 삭제는 전체 삭제
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
const A = "o5_a1";

const owner = await adminAuth().createUser({ email: "owner5@t.dev", password: "pass1234", emailVerified: true });
await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "보안 학원", status: "active" });

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);
const asOwner = () => signInWithEmailAndPassword(auth, "owner5@t.dev", "pass1234");
const AUTH_REJECT = /auth\/(wrong-password|invalid-credential|invalid-login-credentials)/;

/** 서버 `internalEmailForAttnId`와 같은 규칙 */
const internalEmail = (attnId) => `attn+${attnId.replace(/[^a-zA-Z0-9._-]/g, "_")}@provision.attndot.internal`;

async function memberAttnId(col, uid) {
  return (await db.doc(`academies/${A}/${col}/${uid}`).get()).get("attnId");
}

/** 내부 이메일 + 이 비밀번호로 Auth 직접 로그인이 실패해야 함 */
async function assertNoDirectLogin(col, uid, password, label) {
  const email = internalEmail(await memberAttnId(col, uid));
  // 거부 이유가 "사용자 없음"이 아니라 비밀번호 불일치임을 보장
  const user = await adminAuth().getUserByEmail(email);
  assert.equal(user.uid, uid, `${label}: 내부 이메일 사용자`);
  assert.ok(user.providerData.some((p) => p.providerId === "password"), `${label}: 비밀번호 제공자`);
  await assert.rejects(signInWithEmailAndPassword(auth, email, password), AUTH_REJECT, label);
}

async function loginTeacher(loginId, password) {
  const res = await call("signInTeacher", { loginId, password });
  await signInWithCustomToken(auth, res.customToken);
  return res;
}

/** 실패한 호출의 코드·문구 */
async function failure(promise) {
  try {
    await promise;
  } catch (e) {
    return { code: e.code, message: e.message };
  }
  assert.fail("실패해야 하는 호출이 성공함");
}

// --- 계정 직접 만들기 → 임시 비밀번호·첫 로그인·변경 뒤 모두 Auth 직접 로그인 불가 ---
await asOwner();
await call("listAcademyRoles", { academyId: A });
const { accounts } = await call("createStaffAccounts", {
  academyId: A,
  items: [
    { displayName: "보안 직원", roleId: "teacher" },
    { displayName: "퇴사 직원", roleId: "teacher" },
    { displayName: "취소 직원", roleId: "teacher" },
  ],
});
const [acct, leaver, cancelled] = accounts;
await signOut(auth);
await assertNoDirectLogin("staff", acct.authUid, acct.tempPassword, "임시 비밀번호");

await loginTeacher(acct.loginId, acct.tempPassword);
await call("completeMemberFirstLogin", { newPassword: "ownpass1" });
await signOut(auth);
await assertNoDirectLogin("staff", acct.authUid, "ownpass1", "첫 로그인 비밀번호");

await loginTeacher(acct.loginId, "ownpass1");
await call("updateTeacherPassword", { currentPassword: "ownpass1", newPassword: "ownpass2" });
await signOut(auth);
await assertNoDirectLogin("staff", acct.authUid, "ownpass2", "변경한 비밀번호");

// 초대 링크 가입(본인이 정한 비밀번호)
await asOwner();
const invite = await call("createStaffInvite", { academyId: A, displayName: "링크 직원", roleId: "teacher" });
await signOut(auth);
await call("acceptStaffInvite", {
  token: new URL(invite.url).searchParams.get("token"), method: "password", loginId: "linkhard", password: "linkpw12",
});
const linkUid = (await db.collection(`academies/${A}/staff`).where("loginId", "==", "linkhard").get()).docs[0].id;
await assertNoDirectLogin("staff", linkUid, "linkpw12", "초대 링크 가입 비밀번호");

// 학부모 자가 가입
await call("registerParentSelfSignup", {
  academyId: A, loginId: "parenthard", displayName: "학부모", password: "parentpw1",
  phone: "010-7777-8888", contactEmail: "p5@t.dev", agreeTerms: true,
});
const parentUid = (await db.collection(`academies/${A}/parents`).where("loginId", "==", "parenthard").get()).docs[0].id;
await assertNoDirectLogin("parents", parentUid, "parentpw1", "학부모 가입 비밀번호");

// --- 로그인 실패 응답 통일 ---
const missing = await failure(call("signInTeacher", { loginId: "nobody-hard", password: "whatever1" }));
const wrong = await failure(call("signInTeacher", { loginId: acct.loginId, password: "wrongpw9" }));
const otherRole = await failure(call("signInParent", { loginId: acct.loginId, password: "ownpass2" }));
assert.deepEqual(missing, wrong, "없는 ID와 틀린 비밀번호");
assert.deepEqual(otherRole, wrong, "다른 역할의 ID");
assert.equal(wrong.code, "functions/permission-denied");

// --- 본인 재확인: 서버 확인 + 새 토큰, 로그인과 같은 잠금 ---
await loginTeacher(acct.loginId, "ownpass2");
const bad = await failure(call("reauthenticateMember", { password: "nope1234" }));
assert.equal(bad.code, "functions/permission-denied");
assert.match(bad.message, /비밀번호가 올바르지 않습니다/);
const { customToken } = await call("reauthenticateMember", { password: "ownpass2" });
const re = await signInWithCustomToken(auth, customToken);
assert.equal(re.user.uid, acct.authUid);
for (let i = 0; i < 5; i++) {
  await assert.rejects(call("reauthenticateMember", { password: `nope${i}xyz` }), /올바르지 않습니다/);
}
await assert.rejects(call("reauthenticateMember", { password: "ownpass2" }), /잠시 잠겼습니다/);
await signOut(auth);
await assert.rejects(call("signInTeacher", { loginId: acct.loginId, password: "ownpass2" }), /잠시 잠겼습니다/);

// 비밀번호 초기화로 잠금 해제 — 새 임시 비밀번호로도 Auth 직접 로그인 불가
await asOwner();
const reset = await call("resetMemberPassword", { academyId: A, memberAuthUid: acct.authUid, role: "teacher" });
await signOut(auth);
await assertNoDirectLogin("staff", acct.authUid, reset.tempPassword, "초기화 임시 비밀번호");
await loginTeacher(acct.loginId, reset.tempPassword);
await signOut(auth);

// --- 계정 삭제: 써 오던(비활성) 계정은 인사 기록 유지 ---
await loginTeacher(leaver.loginId, leaver.tempPassword);
await call("completeMemberFirstLogin", { newPassword: "leaverpw1" });
await signOut(auth);
await asOwner();
await call("saveStaffMember", {
  academyId: A, staffId: leaver.authUid, displayName: "퇴사 직원", phone: "010-5555-6666",
  jobTitleId: null, hireDate: "2026-03-02", employmentStatus: "resigned", memo: "3월 입사",
});
assert.equal((await db.doc(`academies/${A}/staff/${leaver.authUid}`).get()).get("status"), "inactive", "퇴사 → 비활성");
const removed = await call("deleteTeacherInvite", { academyId: A, teacherId: leaver.authUid });
assert.ok(removed.keptStaffId && removed.keptStaffId !== leaver.authUid);
assert.equal((await db.doc(`academies/${A}/staff/${leaver.authUid}`).get()).exists, false, "uid 경로 문서 없음");
const kept = (await db.doc(`academies/${A}/staff/${removed.keptStaffId}`).get()).data();
assert.equal(kept.status, "no_account");
assert.equal(kept.authUid, null);
assert.deepEqual(kept.permissions, []);
assert.equal(kept.displayName, "퇴사 직원");
assert.ok(String(kept.phone).replace(/\D/g, "") === "01055556666", "연락처 유지");
assert.equal(kept.hireDate, "2026-03-02");
assert.equal(kept.employmentStatus, "resigned");
assert.equal(kept.memo, "3월 입사");
assert.equal("loginId" in kept, false);
await assert.rejects(adminAuth().getUser(leaver.authUid), /no user record|user-not-found/i, "Auth 사용자 삭제");
assert.equal((await db.doc(`attnLoginIndex/${leaver.loginId}`).get()).exists, false, "로그인 인덱스 삭제");
assert.equal(
  (await db.doc(`academies/${A}/staff/${leaver.authUid}/secrets/login`).get()).exists, false, "secrets 삭제",
);
await assert.rejects(call("signInTeacher", { loginId: leaver.loginId, password: "leaverpw1" }), /올바르지 않습니다/);
// 남은 인사 기록은 재직으로 바꾸면 다시 초대 가능
await call("saveStaffMember", {
  academyId: A, staffId: removed.keptStaffId, displayName: "퇴사 직원", phone: kept.phone,
  jobTitleId: null, hireDate: "2026-03-02", employmentStatus: "employed", memo: "복직",
});
await call("createStaffInvite", { academyId: A, staffId: removed.keptStaffId, roleId: "teacher" });

// 첫 로그인 전 계정 삭제(초대 취소)는 전체 삭제
const cancelRes = await call("deleteTeacherInvite", { academyId: A, teacherId: cancelled.authUid });
assert.equal(cancelRes.keptStaffId, null);
const leftovers = await db.collection(`academies/${A}/staff`).where("displayName", "==", "취소 직원").get();
assert.equal(leftovers.size, 0, "직원 정보까지 삭제");
await signOut(auth);

console.log("SMOKE OK (member auth hardening)");
process.exit(0);
