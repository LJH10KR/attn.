/**
 * 학원 삭제 전체 정리(2-N N6~N9) 통합 스모크 — `npm run test:functions`.
 * - 원장 삭제: 이름 확인·권한·최근 인증, 하위 데이터 전부(원생 하위 기록·출결·반·이력·보호자 번호·학부모·직원·역할·meta/*·벨·알림·결제)·
 *   가입 링크·로그인 색인·푸시 전달·푸시 횟수 제한 정리, 트리거가 잠잠해진 뒤에도 학원 아래 빈 것(B2), 멤버 Auth(다른 소속이면 유지 +
 *   클레임·미러가 남은 소속을 가리킴 — B4), 원장 계정 유지(★3).
 * - 이어서 지우기: 학원 문서가 없고 삭제 표시만 남은 상태에서 같은 호출로 마무리.
 * - 찾기: 학원 문서 없이 남은 계정은 아이디 찾기에서 빠짐(N9 ④). 잔여 점검·정리(`adminOrphanData`).
 * - 관리자 삭제도 결제 기록까지. 학원이 지우는 직원 계정(`deleteTeacherInvite`)·학부모 계정도 다른 소속이면 Auth 유지(★5),
 *   학원을 모두 지운 원장(원장 표시만 남음)은 학부모 소속이 지워져도 users 유지.
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
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { CONSENTS, seedSignupToken } from "./_signup-token.mjs";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const D = "o41_a1"; // 원장이 지울 학원
const E = "o42_a1"; // 다른 원장의 학원(멤버가 함께 소속)

const owner = await adminAuth().createUser({ email: "owner41@t.dev", password: "pass1234", emailVerified: true });
const otherOwner = await adminAuth().createUser({ email: "owner42@t.dev", password: "pass1234", emailVerified: true });
await db.doc(`users/${owner.uid}`).set({ platformRole: "owner", displayName: "원장41" });
await db.doc(`users/${otherOwner.uid}`).set({ platformRole: "owner", displayName: "원장42" });
await db.doc(`academies/${D}`).set({ ownerUid: owner.uid, name: "삭제 학원", status: "active" });
await db.doc(`academies/${E}`).set({ ownerUid: otherOwner.uid, name: "남는 학원", status: "active" });
for (const a of [D, E]) await db.doc(`academies/${a}/meta/seq`).set({ nextTeacherSeq: 1, nextParentSeq: 1, nextStudentSeq: 1 });
const PD = await seedSignupToken(db, D, "parent");
const SD = await seedSignupToken(db, D, "staff");
const PE = await seedSignupToken(db, E, "parent");

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reason = (re) => (e) => e?.details?.reason === re;
async function as(email) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, email, "pass1234");
}
async function asGoogle(sub, email) {
  await signOut(auth);
  return (await signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({ sub, email, email_verified: true })))).user;
}
async function clearIssueCounters() {
  for (const d of (await db.collection("phoneVerificationCounters").get()).docs) {
    if (/^(phone_hr_|phone_day_|ip_hr_|ip_rcv_hr_)/.test(d.id)) await d.ref.delete();
  }
}
async function proof(phone, purpose, token) {
  await clearIssueCounters();
  const s = await call("startPhoneVerification", { purpose, phone, ...(token ? { token } : {}) });
  assert.equal(s.status, "issued");
  const c = await call("checkPhoneVerification", { verificationId: s.verificationId });
  return c.proof;
}
async function authGone(uid) {
  try {
    await adminAuth().getUser(uid);
    return false;
  } catch {
    return true;
  }
}
async function subcollections(path) {
  return (await db.doc(path).listCollections()).map((c) => c.id).sort();
}
async function waitFor(fn, label, ms = 8000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > until) assert.fail(`시간 안에 끝나지 않음: ${label}`);
    await sleep(300);
  }
}

const X = "010-6410-0001";

// ===== 학원 D 채우기 =====
await signOut(auth);
await call("registerParentSelfSignup", {
  token: PD, loginId: "delparent", displayName: "삭제 학부모", phone: X, password: "pw123456", consents: CONSENTS,
  phoneProof: await proof(X, "parent_signup", PD),
});
const P = (await db.doc("attnLoginIndex/delparent").get()).get("authUid");
await call("registerStaffSignup", {
  token: SD, method: "password", displayName: "삭제 직원", phone: "010-6410-0002", loginId: "delstaff", password: "pw123456",
  consents: CONSENTS, phoneProof: await proof("010-6410-0002", "staff_signup", SD),
});
const S = (await db.doc("attnLoginIndex/delstaff").get()).get("authUid");
// M: Google 학부모 — D와 E 둘 다(학원 삭제 뒤 Auth 유지, 클레임은 E로)
await asGoogle("del-m-1", "delm1@gmail.com");
await call("registerParentGoogleSignup", { token: PE, displayName: "두 학원 학부모", phone: "010-6410-0003", consents: CONSENTS });
const M = auth.currentUser.uid;
// 두 번째 학원 소속(Google 가입은 로그인 ID가 전역에 하나라 Admin으로)
await db.doc(`academies/${D}/parents/${M}`).set({ authUid: M, displayName: "두 학원 학부모", status: "pending_approval", authProvider: "google" });
await adminAuth().setCustomUserClaims(M, { role: "parent", academyId: D, membershipStatus: "pending_approval" });
// K: Google 학부모 — D만
await asGoogle("del-k-1", "delk1@gmail.com");
await call("registerParentGoogleSignup", { token: PD, displayName: "한 학원 학부모", phone: "010-6410-0004", consents: CONSENTS });
const K = auth.currentUser.uid;

const st = `academies/${D}/students/s1`;
await db.doc(st).set({ academyId: D, name: "원생", status: "enrolled", classIds: ["c1"], teacherUids: [S], parentUids: [P] });
for (const [p, v] of [
  [`${st}/attendanceRecords/2026-11-01`, { status: "present" }],
  [`${st}/tuitionInvoices/2026-11`, { amount: 1 }],
  [`${st}/sessionLogs/l1`, { n: 1 }],
  [`${st}/serverSecrets/checkIn`, { pinHash: "x" }],
  [`academies/${D}/studentNotes/s1`, { text: "메모" }],
  [`academies/${D}/attendance/a1`, { studentId: "s1" }],
  [`academies/${D}/classes/c1`, { name: "반", teacherUids: [S], status: "active" }],
  [`academies/${D}/classHistory/h1`, { type: "x" }],
  [`academies/${D}/meta/onboarding`, { done: true }],
  [`academies/${D}/meta/options`, { rooms: [] }],
  [`academies/${D}/roles/r1`, { name: "역할" }],
  [`academies/${D}/adminInbox/i1`, { kind: "x" }],
  [`academies/${D}/attendanceNotifications/n1`, { studentId: "s1" }],
  [`academies/${D}/payments/pay1`, { studentId: "s1", amount: 1000, status: "PAID", createdAt: Timestamp.now() }],
  [`academies/${D}/secrets/login`, { legacy: true }],
  [`academies/${D}/someFutureCollection/x`, { v: 1 }],
  ["_pushDeliveries/del-1", { academyId: D, recipientUid: P }],
  [`_pushRateLimits/attendance_${D}_s1`, { n: 1 }],
  [`_pushRateLimits/class_attendance_${D}_c1_s1`, { n: 1 }],
  [`_pushRateLimits/attendance_${D}0_s1`, { n: 1 }], // 다른 학원(접두가 비슷) — 남아야 함
]) await db.doc(p).set(v);
const signupHashes = (await db.collection("signupLinks").where("academyId", "==", D).get()).docs.map((d) => d.id);
assert.ok(signupHashes.length >= 2);

// ===== 확인 실패 경우 =====
await as("owner42@t.dev");
await assert.rejects(call("deleteOwnerAcademy", { academyId: D, confirmName: "삭제 학원" }), /권한이 없습니다/, "남의 학원");
await as("owner41@t.dev");
await assert.rejects(call("deleteOwnerAcademy", { academyId: D, confirmName: "삭제 학" }), reason("name_mismatch"), "이름 틀림");
await db.doc("_emulatorTest/recentAuth").set({ maxAgeMs: 1 });
await sleep(1200);
await assert.rejects(call("deleteOwnerAcademy", { academyId: D, confirmName: " 삭제 학원 " }), reason("reauth_required"), "최근 인증 아님");
await db.doc("_emulatorTest/recentAuth").delete();
assert.equal((await db.doc(`academies/${D}`).get()).exists, true);
// 클라이언트 직접 삭제는 규칙이 막음(규칙 테스트) — 여기서는 서버 경로만

// ===== 원장 삭제 =====
await as("owner41@t.dev");
assert.deepEqual(await call("deleteOwnerAcademy", { academyId: D, confirmName: " 삭제 학원 " }), { ok: true });
assert.equal((await db.doc(`academies/${D}`).get()).exists, false);
assert.deepEqual(await subcollections(`academies/${D}`), [], "학원 아래 전부(결제·meta·처음 보는 컬렉션 포함)");
for (const h of signupHashes) assert.equal((await db.doc(`signupLinks/${h}`).get()).exists, false, "가입 링크");
for (const k of ["delparent", "delstaff"]) assert.equal((await db.doc(`attnLoginIndex/${k}`).get()).exists, false, `색인 ${k}`);
assert.equal((await db.doc("_pushDeliveries/del-1").get()).exists, false);
assert.equal((await db.doc(`_pushRateLimits/attendance_${D}_s1`).get()).exists, false);
assert.equal((await db.doc(`_pushRateLimits/class_attendance_${D}_c1_s1`).get()).exists, false);
assert.equal((await db.doc(`_pushRateLimits/attendance_${D}0_s1`).get()).exists, true, "비슷한 접두의 다른 학원은 유지");
assert.equal((await db.doc(`_academyDeletions/${D}`).get()).exists, false, "삭제 표시 정리");
for (const u of [P, S, K]) {
  assert.ok(await authGone(u), `멤버 Auth ${u}`);
  assert.equal((await db.doc(`users/${u}`).get()).exists, false);
}
// B4 — 다른 소속이 남은 M: Auth 유지 + 클레임·미러는 E
assert.equal((await adminAuth().getUser(M)).customClaims?.academyId, E, "클레임이 남은 학원(E)");
await waitFor(
  async () => (await db.doc(`users/${M}/serverMirror/activation`).get()).get("parent.primaryAcademyId") === E,
  "미러가 남은 학원(E)",
);
assert.equal((await db.doc(`academies/${E}/parents/${M}`).get()).exists, true);
// ★3 원장 계정 유지
assert.equal((await adminAuth().getUser(owner.uid)).uid, owner.uid);
assert.equal((await db.doc(`users/${owner.uid}`).get()).get("platformRole"), "owner");
// B2 — 삭제 트리거가 잠잠해진 뒤에도 다시 생긴 문서 없음
for (let i = 0; i < 6; i += 1) {
  await sleep(1000);
  assert.deepEqual(await subcollections(`academies/${D}`), [], `삭제 ${i + 1}초 뒤 학원 아래 빈 것`);
}
// 이미 끝난 삭제를 다시 부르면 not-found
await assert.rejects(call("deleteOwnerAcademy", { academyId: D, confirmName: "삭제 학원" }), /찾을 수 없습니다/);

// ===== 이어서 지우기 — 학원 문서는 없고 삭제 표시·하위 문서가 남은 상태 =====
const D2 = "o41_a2";
await db.doc(`academies/${D2}/meta/onboarding`).set({ x: 1 });
await db.doc(`academies/${D2}/payments/p`).set({ amount: 1 });
await db.doc(`_academyDeletions/${D2}`).set({ academyId: D2, ownerUid: owner.uid, memberAuthUids: [] });
await assert.rejects(
  (async () => { await as("owner42@t.dev"); return call("deleteOwnerAcademy", { academyId: D2 }); })(),
  /찾을 수 없습니다/,
  "다른 원장은 이어서 지울 수 없음",
);
await as("owner41@t.dev");
assert.deepEqual(await call("deleteOwnerAcademy", { academyId: D2 }), { ok: true });
assert.deepEqual(await subcollections(`academies/${D2}`), []);
assert.equal((await db.doc(`_academyDeletions/${D2}`).get()).exists, false);

// ===== 찾기 결과에서 학원 문서가 없는 계정 제외(N9 ④) + 잔여 점검·정리 =====
const F = "o43_a1";
const fOwner = await adminAuth().createUser({ email: "owner43@t.dev", password: "pass1234" });
await db.doc(`academies/${F}`).set({ ownerUid: fOwner.uid, name: "예전 학원", status: "active" });
await db.doc(`academies/${F}/meta/seq`).set({ nextTeacherSeq: 1, nextParentSeq: 1, nextStudentSeq: 1 });
const PF = await seedSignupToken(db, F, "parent");
await signOut(auth);
await call("registerParentSelfSignup", {
  token: PF, loginId: "orphanparent", displayName: "남은 학부모", phone: X, password: "pw123456", consents: CONSENTS,
  phoneProof: await proof(X, "parent_signup", PF),
});
const OP = (await db.doc("attnLoginIndex/orphanparent").get()).get("authUid");
await db.doc(`academies/${F}`).delete(); // 예전 원장 삭제처럼 학원 문서만 지움
const found = await call("findLoginIdsByPhone", { phone: X, phoneProof: await proof(X, "find_login_id") });
assert.ok(!found.accounts.some((a) => a.loginId === "orphanparent"), "학원 문서 없는 계정은 찾기에서 빠짐");

const adminUser = await adminAuth().createUser({ email: "admin41@t.dev", password: "pass1234" });
await adminAuth().setCustomUserClaims(adminUser.uid, { admin: true });
await as("admin41@t.dev");
const scan = (await call("adminOrphanData", { mode: "scan" })).report;
const ph = scan.phantomAcademies.find((p) => p.academyId === F);
assert.ok(ph && ph.collections.parents >= 1 && ph.collections.meta >= 1, "잔여 학원 ① 보고");
assert.ok(scan.orphanLoginIndex.some((x) => x.key === "orphanparent"), "잔여 색인 ③ 보고");
assert.ok(scan.orphanSignupLinks.some((x) => x.academyId === F), "잔여 가입 링크 ④ 보고");
assert.ok(scan.academiesWithoutOwnerAuth.every((x) => x.academyId !== E));
const purged = await call("adminOrphanData", { mode: "purge" });
assert.ok(!purged.report.phantomAcademies.some((p) => p.academyId === F), "정리 뒤 잔여 학원 없음");
assert.ok(!purged.report.orphanLoginIndex.some((x) => x.key === "orphanparent"));
assert.ok(!purged.report.orphanSignupLinks.some((x) => x.academyId === F));
assert.ok(await authGone(OP), "잔여 학원 학부모 Auth 정리");
assert.equal((await db.doc(`academies/${E}`).get()).exists, true, "살아 있는 학원은 그대로");

// ===== 관리자 학원 삭제도 결제 기록까지 =====
await db.doc("academies/o44_a1").set({ ownerUid: fOwner.uid, name: "관리자 삭제 학원" });
await db.doc("academies/o44_a1/payments/p1").set({ amount: 1 });
await call("adminDeleteAcademyCascade", { academyId: "o44_a1" });
assert.deepEqual(await subcollections("academies/o44_a1"), [], "관리자 삭제 — 결제 기록 포함(N8)");

// ===== ★5 학원이 지우는 직원 계정 — 다른 학원 소속이면 Auth 유지 =====
const T = await adminAuth().createUser({ email: "multi41@t.dev", password: "pass1234" });
await db.doc(`academies/${E}/staff/${T.uid}`).set({ authUid: T.uid, displayName: "두 학원 직원", status: "active", roleId: "r", permissions: [] });
const G2 = "o45_a1";
await db.doc(`academies/${G2}`).set({ ownerUid: otherOwner.uid, name: "셋째 학원", status: "active" });
await db.doc(`academies/${G2}/staff/${T.uid}`).set({ authUid: T.uid, displayName: "두 학원 직원", status: "active", roleId: "r", permissions: [] });
await as("owner42@t.dev");
await call("deleteTeacherInvite", { academyId: E, teacherId: T.uid });
assert.equal((await adminAuth().getUser(T.uid)).uid, T.uid, "다른 학원 직원이면 Auth 유지");
assert.equal((await adminAuth().getUser(T.uid)).customClaims?.academyId, G2, "클레임은 남은 학원");

// ===== 학원을 모두 지운 원장(원장 표시만) — 학부모 소속이 지워져도 계정·users 유지 =====
await db.doc(`academies/${E}/parents/${owner.uid}`).set({ authUid: owner.uid, displayName: "원장 겸 학부모", status: "pending_approval" });
await call("deleteParentAccount", { academyId: E, parentUid: owner.uid });
await sleep(1500); // 미러 트리거
assert.equal((await adminAuth().getUser(owner.uid)).uid, owner.uid, "원장 계정 유지");
assert.equal((await db.doc(`users/${owner.uid}`).get()).get("platformRole"), "owner", "원장 users 유지(트리거도 지우지 않음)");

console.log("SMOKE OK (academy delete)");
process.exit(0);
