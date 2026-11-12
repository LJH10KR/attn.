/**
 * 본인 회원 탈퇴(2-N) 통합 스모크 — `npm run test:functions`(가짜 OCTOMO).
 * - 최근 인증(에뮬레이터 전용 `_emulatorTest/recentAuth.maxAgeMs`로 "오래된 로그인"을 만듦) 없으면 거부.
 * - 학부모(로그인 ID): 연결 해제·번호 색인·로그인 정보·색인·계정·사용자 데이터·푸시 전달·Auth 삭제, 원생 보호자 칸·결제 기록 남음,
 *   원장 벨(번호 없음), 재설정 표를 받은 뒤 탈퇴 → `no_match`, 아이디 찾기·비밀번호 찾기에서 빠짐, 다시 불러도 ok.
 * - Google 학부모(학원 2곳): 둘 다 정리·벨 2.
 * - 직원: 「계정 없음」 인사 기록 1건(동시 2회 호출에도), 반 담당에서 빠짐, 벨 variant, 진행 기록으로 멈춘 반 정리 이어서.
 * - 원장: 학원 있으면 거부 → 학원 삭제 뒤 탈퇴(다른 학원 학부모 소속도 함께, 동의 기록 삭제). admin 거부.
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
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { CONSENTS, seedSignupToken } from "./_signup-token.mjs";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A1 = "o31_a1";
const A2 = "o31_a2";

const owner = await adminAuth().createUser({ email: "owner31@t.dev", password: "pass1234", emailVerified: true });
await db.doc(`users/${owner.uid}`).set({ platformRole: "owner", displayName: "원장31" });
for (const [id, name] of [[A1, "탈퇴 학원"], [A2, "둘째 탈퇴 학원"]]) {
  await db.doc(`academies/${id}`).set({ ownerUid: owner.uid, name, status: "active" });
  await db.doc(`academies/${id}/meta/seq`).set({ nextTeacherSeq: 1, nextParentSeq: 1, nextStudentSeq: 1 });
}
const PA1 = await seedSignupToken(db, A1, "parent");
const SA1 = await seedSignupToken(db, A1, "staff");

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reason = (re) => (e) => e?.details?.reason === re;

async function clearIssueCounters() {
  for (const d of (await db.collection("phoneVerificationCounters").get()).docs) {
    if (/^(phone_hr_|phone_day_|ip_hr_|ip_rcv_hr_|reset_id_)/.test(d.id)) await d.ref.delete();
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
async function asOwner(email = "owner31@t.dev") {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, email, "pass1234");
}
async function asMember(fn, loginId, password = "pw123456") {
  await signOut(auth);
  const res = await call(fn, { loginId, password });
  await signInWithCustomToken(auth, res.customToken);
}
async function asGoogle(sub, email) {
  await signOut(auth);
  return (await signInWithCredential(
    auth,
    GoogleAuthProvider.credential(JSON.stringify({ sub, email, email_verified: true })),
  )).user;
}
/** 에뮬레이터 전용 — 최근 인증 허용 시간 조정(B3) */
const setRecentAuthMaxAge = (ms) =>
  ms ? db.doc("_emulatorTest/recentAuth").set({ maxAgeMs: ms }) : db.doc("_emulatorTest/recentAuth").delete();
async function waitFor(fn, label, ms = 8000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > until) assert.fail(`시간 안에 끝나지 않음: ${label}`);
    await sleep(300);
  }
}
async function authGone(uid) {
  try {
    await adminAuth().getUser(uid);
    return false;
  } catch {
    return true;
  }
}

const X = "010-6310-0001";
const XKEY = "01063100001";

// ===== 1. 로그인 ID 학부모 =====
await signOut(auth);
const pSign = await call("registerParentSelfSignup", {
  token: PA1, loginId: "wdparent", displayName: "탈퇴 학부모", phone: X, password: "pw123456", consents: CONSENTS,
  phoneProof: await proof(X, "parent_signup", PA1),
});
const P = (await db.doc(`attnLoginIndex/${pSign.loginId}`).get()).get("authUid");
// 원생(학원이 적은 보호자 칸) + 연결 + 결제 + 푸시 전달
await db.doc(`academies/${A1}/students/s1`).set({
  academyId: A1, name: "원생1", status: "enrolled", classIds: [], teacherUids: [], parentUids: [],
  guardians: [{ name: "보호자", phone: X, relation: "모" }], guardianPhones: [XKEY],
});
await asOwner();
await call("linkParentToStudents", { academyId: A1, parentUid: P, studentIds: ["s1"] });
await waitFor(async () => ((await db.doc(`academies/${A1}/students/s1`).get()).get("parentUids") ?? []).includes(P), "연결");
await db.doc(`academies/${A1}/payments/pay1`).set({
  paymentId: "pay1", studentId: "s1", studentName: "원생1", parentUids: [P], payerUid: P, amount: 1000, status: "PAID",
  createdAt: Timestamp.now(),
});
await db.doc("_pushDeliveries/wd-1").set({ academyId: A1, recipientUid: P, studentId: "s1" });
await db.doc(`users/${P}/pushSubscriptions/sub1`).set({ endpoint: "x" });
const phoneIndexBefore = (await db.collection(`academies/${A1}/parentPhones`).where("parentUid", "==", P).get()).size;

// 비밀번호 재설정 표를 먼저 받아 둠(N9 ②)
await signOut(auth);
const ticketRes = await call("verifyPasswordResetTarget", {
  loginId: "wdparent", phone: X, phoneProof: await proof(X, "reset_password"),
});
assert.equal(ticketRes.status, "ok", "탈퇴 전 재설정 표");

// 정보
await asMember("signInParent", "wdparent");
const pInfo = await call("getAccountWithdrawalInfo", {});
assert.equal(pInfo.blocked, null);
assert.deepEqual(pInfo.memberships, [{ role: "parent", academyName: "탈퇴 학원" }]);
assert.equal(pInfo.reauth.memberPassword, true);
assert.equal(pInfo.reauth.google, false);

// 최근 인증 없으면 거부
await setRecentAuthMaxAge(1);
await sleep(1200);
await assert.rejects(call("withdrawAccount", {}), reason("reauth_required"), "최근 인증 아님 → 거부");
await setRecentAuthMaxAge(0);
assert.equal((await db.doc(`academies/${A1}/parents/${P}`).get()).exists, true, "거부되면 아무것도 안 지움");

// 탈퇴
await asMember("signInParent", "wdparent");
assert.deepEqual(await call("withdrawAccount", {}), { ok: true });
assert.equal((await db.doc(`academies/${A1}/parents/${P}`).get()).exists, false, "학부모 계정 문서");
assert.equal((await db.collection(`academies/${A1}/parents/${P}/secrets`).get()).size, 0, "로그인 정보");
assert.equal((await db.doc("attnLoginIndex/wdparent").get()).exists, false, "로그인 색인");
assert.equal((await db.collection(`academies/${A1}/parentPhones`).where("parentUid", "==", P).get()).size, 0, "번호 색인");
assert.ok(phoneIndexBefore >= 0);
const s1 = (await db.doc(`academies/${A1}/students/s1`).get()).data();
assert.ok(!(s1.parentUids ?? []).includes(P), "연결 해제");
assert.equal(s1.guardians[0].phone, X, "학원이 적은 보호자 칸은 남음");
assert.equal((await db.doc(`academies/${A1}/payments/pay1`).get()).get("payerUid"), P, "결제 기록 남음");
await waitFor(async () => !((await db.doc(`academies/${A1}/payments/pay1`).get()).get("parentUids") ?? []).includes(P), "결제 parentUids 정리");
assert.equal((await db.doc(`users/${P}`).get()).exists, false, "users");
assert.equal((await db.collection(`users/${P}/pushSubscriptions`).get()).size, 0, "알림 토큰");
assert.equal((await db.doc("_pushDeliveries/wd-1").get()).exists, false, "푸시 전달(F9)");
assert.ok(await authGone(P), "Auth");
const pBell = (await db.doc(`academies/${A1}/adminInbox/withdrawn-parent-${P}`).get()).data();
assert.equal(pBell.kind, "member_withdrawn");
assert.equal(pBell.entityType, "parent");
assert.equal(pBell.displayName, "탈퇴 학부모");
assert.ok(!JSON.stringify(pBell).includes("6310"), "벨에 전화번호 없음");
// 다시 불러도 ok(응답을 잃은 재시도)
assert.deepEqual(await call("withdrawAccount", {}), { ok: true }, "재호출 ok");
// 탈퇴 직후 같은 토큰으로 푸시 끄기(예전 로그아웃 정리 경로) → 지운 users 문서를 다시 만들지 않음(2-N 배포 뒤 후속)
assert.deepEqual(await call("syncParentPushSubscription", { enabled: false }), { ok: true, pushNotificationsEnabled: false });
assert.equal((await db.doc(`users/${P}`).get()).exists, false, "푸시 끄기는 없는 users 문서를 만들지 않음");
// 재설정 표 → no_match, 찾기에서 빠짐
await signOut(auth);
assert.equal((await call("resetPasswordWithPhone", { ticket: ticketRes.ticket, newPassword: "newpw123" })).status, "no_match");
const found = await call("findLoginIdsByPhone", { phone: X, phoneProof: await proof(X, "find_login_id") });
assert.ok(!found.accounts.some((a) => a.loginId === "wdparent"), "아이디 찾기에서 빠짐");
assert.equal(
  (await call("verifyPasswordResetTarget", { loginId: "wdparent", phone: X, phoneProof: await proof(X, "reset_password") })).status,
  "no_match",
  "비밀번호 찾기 대상 아님",
);

// ===== 2. Google 학부모 — 학원 2곳 =====
await asGoogle("wd-g-1", "wdg1@gmail.com");
await call("registerParentGoogleSignup", { token: PA1, displayName: "구글 학부모", phone: "010-6310-0002", consents: CONSENTS });
const G = auth.currentUser.uid;
// 두 번째 학원 소속(Google 가입은 로그인 ID가 전역에 하나라, 다른 학원 계정 문서는 Admin으로)
await db.doc(`academies/${A2}/parents/${G}`).set({ authUid: G, displayName: "구글 학부모", status: "pending_approval", authProvider: "google" });
assert.equal((await db.doc(`academies/${A2}/parents/${G}`).get()).exists, true);
// 푸시 켜기 → 끄기(문서가 있으면 그대로 끄기 기록 + 구독 정리)
await call("syncParentPushSubscription", { enabled: true, fcmToken: "f".repeat(120) });
assert.equal((await db.doc(`users/${G}`).get()).get("pushNotificationsEnabled"), true);
assert.equal((await db.collection(`users/${G}/pushSubscriptions`).get()).size, 1);
await call("syncParentPushSubscription", { enabled: false });
assert.equal((await db.doc(`users/${G}`).get()).get("pushNotificationsEnabled"), false, "있는 문서는 끄기 기록");
assert.equal((await db.collection(`users/${G}/pushSubscriptions`).get()).size, 0, "구독 정리");
const gInfo = await call("getAccountWithdrawalInfo", {});
assert.equal(gInfo.memberships.length, 2);
assert.equal(gInfo.reauth.google, true);
assert.equal(gInfo.reauth.memberPassword, false);
await asGoogle("wd-g-1", "wdg1@gmail.com"); // 다시 로그인 = 최근 인증
assert.deepEqual(await call("withdrawAccount", {}), { ok: true });
for (const a of [A1, A2]) {
  assert.equal((await db.doc(`academies/${a}/parents/${G}`).get()).exists, false, `${a} 학부모 정리`);
  assert.equal((await db.doc(`academies/${a}/adminInbox/withdrawn-parent-${G}`).get()).get("kind"), "member_withdrawn");
}
assert.ok(await authGone(G));

// ===== 3. 직원 — 인사 기록 1건, 반 담당 정리 =====
await signOut(auth);
await call("registerStaffSignup", {
  token: SA1, method: "password", displayName: "탈퇴 직원", phone: "010-6310-0003", loginId: "wdstaff", password: "pw123456",
  consents: CONSENTS, phoneProof: await proof("010-6310-0003", "staff_signup", SA1),
});
const S = (await db.doc("attnLoginIndex/wdstaff").get()).get("authUid");
await db.doc(`academies/${A1}/staff/${S}`).update({ status: "active", jobTitleId: "t1", memo: "메모" });
await db.doc(`academies/${A1}/classes/c1`).set({ name: "반1", teacherUids: [S], teacherUid: S, status: "active" });
await asMember("signInTeacher", "wdstaff");
const both = await Promise.allSettled([call("withdrawAccount", {}), call("withdrawAccount", {})]);
assert.ok(both.some((r) => r.status === "fulfilled"), "동시 2회 중 하나 이상 성공");
await waitFor(async () => await authGone(S), "직원 Auth");
const hr = (await db.collection(`academies/${A1}/staff`).where("displayName", "==", "탈퇴 직원").get()).docs;
assert.equal(hr.length, 1, "인사 기록 1건(F6)");
assert.equal(hr[0].get("status"), "no_account");
assert.equal(hr[0].get("memo"), "메모");
assert.equal(hr[0].get("authUid"), null);
assert.equal(hr[0].get("phoneVerifiedKey"), undefined, "확인 번호는 옮기지 않음");
assert.equal((await db.doc(`academies/${A1}/staff/${S}`).get()).exists, false);
assert.ok(!((await db.doc(`academies/${A1}/classes/c1`).get()).get("teacherUids") ?? []).includes(S), "반 담당에서 빠짐");
assert.equal((await db.doc(`academies/${A1}/adminInbox/withdrawn-teacher-${S}`).get()).get("variant"), "kept_hr_record");

// 멈춘 반 정리 이어서 — 계정 문서는 이미 없고 진행 기록만 남은 상태
const S2u = await adminAuth().createUser({ email: "wdstaff2@t.dev", password: "pass1234" });
await db.doc(`academies/${A1}/classes/c2`).set({ name: "반2", teacherUids: [S2u.uid], teacherUid: S2u.uid, status: "active" });
await db.doc(`_accountWithdrawals/${S2u.uid}`).set({ uid: S2u.uid, staffAcademyIds: [A1] });
await asOwner("wdstaff2@t.dev");
assert.deepEqual(await call("withdrawAccount", {}), { ok: true });
assert.ok(!((await db.doc(`academies/${A1}/classes/c2`).get()).get("teacherUids") ?? []).includes(S2u.uid), "진행 기록으로 반 정리");
assert.equal((await db.doc(`_accountWithdrawals/${S2u.uid}`).get()).exists, false, "진행 기록 정리");

// ===== 4. 원장 — 학원 있으면 거부, 지운 뒤 탈퇴(다른 학원 학부모 소속도) =====
const o2 = await adminAuth().createUser({ email: "owner31b@t.dev", password: "pass1234", emailVerified: true });
await db.doc(`users/${o2.uid}`).set({ platformRole: "owner", displayName: "원장31b" });
await db.doc(`legalConsents/${o2.uid}`).set({ uid: o2.uid, role: "owner" });
await db.doc("academies/o31b_a1").set({ ownerUid: o2.uid, name: "원장 학원", status: "active" });
await db.doc(`academies/${A1}/parents/${o2.uid}`).set({ authUid: o2.uid, displayName: "원장이면서 학부모", status: "pending_approval" });
await asOwner("owner31b@t.dev");
const oInfo = await call("getAccountWithdrawalInfo", {});
assert.equal(oInfo.blocked, "owns_academies");
assert.deepEqual(oInfo.ownedAcademies, [{ academyId: "o31b_a1", name: "원장 학원" }]);
assert.equal(oInfo.reauth.ownerPassword, true);
await assert.rejects(call("withdrawAccount", {}), reason("owns_academies"), "학원 있으면 거부");
await call("deleteOwnerAcademy", { academyId: "o31b_a1", confirmName: "원장 학원" });
assert.equal((await adminAuth().getUser(o2.uid)).uid, o2.uid, "학원 삭제 뒤에도 원장 계정 유지(★3)");
assert.equal((await db.doc(`users/${o2.uid}`).get()).get("platformRole"), "owner");
assert.deepEqual(await call("withdrawAccount", {}), { ok: true });
assert.ok(await authGone(o2.uid));
assert.equal((await db.doc(`users/${o2.uid}`).get()).exists, false);
assert.equal((await db.doc(`legalConsents/${o2.uid}`).get()).exists, false, "동의 기록(★8)");
assert.equal((await db.doc(`academies/${A1}/parents/${o2.uid}`).get()).exists, false, "다른 학원 학부모 소속도");

// ===== 5. admin 거부 =====
const adminUser = await adminAuth().createUser({ email: "admin31@t.dev", password: "pass1234" });
await adminAuth().setCustomUserClaims(adminUser.uid, { admin: true });
await asOwner("admin31@t.dev");
await assert.rejects(call("withdrawAccount", {}), reason("admin"));
assert.equal((await call("getAccountWithdrawalInfo", {})).blocked, "admin");

console.log("SMOKE OK (account withdrawal)");
process.exit(0);
