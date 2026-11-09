/**
 * 학부모 계정 연결 통합 스모크 — `npm run test:functions` (Auth·Firestore·Functions 에뮬레이터)
 * 자가 가입 → OTP → 승인 대기, 같은 번호 두 계정 가입 허용 → 첫 연결이 번호 색인 → 다른 계정 연결 거부,
 * 연결 → active·parentUids·approvedAt·결제 parentUids, 해제 → pending_approval(approvedAt 유지)·결제에서 빠짐,
 * 직접 만들기 → 첫 로그인 → active, 연결 대기 비밀번호 초기화, 비활성 계정 푸시 제외·자동 전환과 겹쳐도 inactive 유지,
 * 이메일 인증 전·비활성 계정 연결 거부, 연결된 보호자 항목 삭제 거부, 계정 삭제(원생 유지·색인 해제),
 * 학생 삭제 시 결제 parentUids 유지, 권한 없는 직원 거부, 학부모 앱 자녀 반 정보(이름·시간만, 종강 제외),
 * 연결 전부 실패 시 새로 잡은 색인 되돌림(기존 색인·동시 연결 성공 시 유지), 원생 저장 시 보호자 생략 = 변경 없음을 확인한다.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { seedSignupToken } from "./_signup-token.mjs";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A = "o7_a1";
const PHONE = "010-2222-3333";
const PHONE_KEY = "01022223333";

const owner = await adminAuth().createUser({ email: "owner7@t.dev", password: "pass1234", emailVerified: true });
const noPermStaff = await adminAuth().createUser({ email: "stu7@t.dev", password: "pass1234" });
await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "연결 학원", status: "active" });
const PARENT_TOKEN = await seedSignupToken(db, A, "parent");
await db.doc(`academies/${A}/meta/seq`).set({ nextTeacherSeq: 1, nextParentSeq: 1, nextStudentSeq: 1 });
await db.doc(`academies/${A}/staff/${noPermStaff.uid}`).set({
  authUid: noPermStaff.uid, displayName: "원생 담당", status: "active", roleId: "x", permissions: ["operations.students"],
});
await db.doc(`academies/${A}/meta/options`).set({
  guardianRelations: [{ id: "mother", label: "어머니" }, { id: "father", label: "아버지" }],
});

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);
const parentDoc = async (uid) => (await db.doc(`academies/${A}/parents/${uid}`).get());
const studentDoc = async (id) => (await db.doc(`academies/${A}/students/${id}`).get()).data();
const sorted = (xs) => [...(xs ?? [])].sort();

/** 트리거 결과 대기 — 조건이 참이 될 때까지 폴링 */
async function waitFor(label, check, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new Error(`시간 초과: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function asOwner() {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, "owner7@t.dev", "pass1234");
}

/** 로그인 ID 로그인(서버 확인 → 커스텀 토큰) */
async function asParent(loginId, password) {
  await signOut(auth);
  const res = await call("signInParent", { loginId, password });
  await signInWithCustomToken(auth, res.customToken);
  return res;
}

/** 자가 가입 + (에뮬레이터) 인증 코드를 알려진 값으로 바꿔 OTP 확인 */
async function selfSignupAndVerify(loginId, displayName, phone) {
  await signOut(auth);
  const res = await call("registerParentSelfSignup", {
    token: PARENT_TOKEN, loginId, displayName, phone, contactEmail: `${loginId}@mail.dev`, password: "pw123456", agreeTerms: true,
  });
  const index = await db.doc(`attnLoginIndex/${res.loginId}`).get();
  const uid = index.get("authUid");
  return { res, uid, verify: async () => {
    await db.doc(`emailVerificationOtps/${uid}`).set({
      codeHash: createHash("sha256").update("123456").digest("hex"),
      email: `${loginId}@mail.dev`, purpose: "parent", attempts: 0,
      expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
    });
    await asParent(loginId, "pw123456");
    await call("verifyEmailVerificationOtp", { code: "123456", purpose: "parent" });
  } };
}

// --- 원생 준비: 형제 둘(같은 보호자 번호), 번호 없는 원생, 결제 1건 ---
await asOwner();
const mk = (name, guardians) => call("saveStudent", { academyId: A, name, grade: "e3", status: "enrolled", guardians });
const s1 = (await mk("형", [{ relationId: "mother", name: "엄마", phone: PHONE }])).studentId;
const s2 = (await mk("동생", [{ relationId: "mother", name: "엄마", phone: PHONE }, { relationId: "father", phone: "010-4444-5555" }])).studentId;
const s3 = (await mk("다른 집", [{ relationId: "father", phone: "010-6666-7777" }])).studentId;
await db.doc(`academies/${A}/payments/pay-s1`).set({ studentId: s1, parentUids: [], amount: 100000, status: "PAID", createdAt: Timestamp.now() });

// --- 자가 가입 → 응답에 번호·원생 정보 없음, 이메일 인증 전 ---
const mom = await selfSignupAndVerify("momseven", "엄마", PHONE);
assert.deepEqual(Object.keys(mom.res).sort(), ["academyId", "attnId", "contactEmail", "loginId", "membershipStatus"]);
assert.equal(mom.res.membershipStatus, "pending_email_verification");
let momSnap = await parentDoc(mom.uid);
assert.equal(momSnap.get("approvedAt"), null, "생성 때 approvedAt null 명시");
assert.equal(momSnap.get("childrenCount"), undefined);

// 이메일 인증 전 계정은 연결 대상이 될 수 없다
await asOwner();
await assert.rejects(call("linkParentToStudents", { academyId: A, parentUid: mom.uid, studentIds: [s1] }), /이메일 인증/);

// OTP → 연결 0명이라 승인 대기
await mom.verify();
assert.equal((await parentDoc(mom.uid)).get("status"), "pending_approval");
assert.equal((await adminAuth().getUser(mom.uid)).customClaims.membershipStatus, "pending_approval");
assert.equal((await adminAuth().getUser(mom.uid)).disabled, false, "승인 대기는 Auth를 끄지 않는다");
// 승인 대기 계정은 빈 목록 + 상태
const waitingList = await call("listParentChildrenStudents", { academyId: A });
assert.equal(waitingList.accountStatus, "pending_approval");
assert.deepEqual(waitingList.students, []);

// --- 같은 번호 두 번째 계정 가입은 허용(색인은 연결 때만) ---
const dup = await selfSignupAndVerify("dupseven", "엄마 둘", PHONE);
await dup.verify();
assert.equal((await parentDoc(dup.uid)).get("status"), "pending_approval");
assert.equal((await db.doc(`academies/${A}/parentPhones/${PHONE_KEY}`).get()).exists, false);

// --- 권한 없는 직원은 연결·직접 만들기·삭제 거부 ---
await signOut(auth);
await signInWithEmailAndPassword(auth, "stu7@t.dev", "pass1234");
await assert.rejects(call("linkParentToStudents", { academyId: A, parentUid: mom.uid, studentIds: [s1] }), /권한/);
await assert.rejects(call("createParentAccount", { academyId: A, displayName: "x", phone: "010-1212-3434", studentIds: [s1] }), /권한/);
await assert.rejects(call("deleteParentAccount", { academyId: A, parentUid: dup.uid }), /권한/);
await assert.rejects(call("unlinkParentFromStudent", { academyId: A, parentUid: mom.uid, studentId: s1 }), /권한/);

// --- 승인(연결): 형제 둘 → 번호 색인·approvedAt·active·parentUids·결제 parentUids ---
await asOwner();
const linked = await call("linkParentToStudents", { academyId: A, parentUid: mom.uid, studentIds: [s1, s2] });
assert.deepEqual(sorted(linked.linked), sorted([s1, s2]));
assert.deepEqual(linked.failures, []);
assert.equal((await db.doc(`academies/${A}/parentPhones/${PHONE_KEY}`).get()).get("parentUid"), mom.uid);
assert.deepEqual((await studentDoc(s1)).parentUids, [mom.uid]);
assert.equal((await studentDoc(s2)).guardians[0].linkedParentUid, mom.uid, "번호가 맞는 보호자 항목에 연결");
assert.equal((await studentDoc(s2)).guardians.length, 2);
await waitFor("연결 → active", async () => (await parentDoc(mom.uid)).get("status") === "active");
await waitFor("요약 2명", async () => ((await parentDoc(mom.uid)).get("linkedStudentIds") ?? []).length === 2);
momSnap = await parentDoc(mom.uid);
assert.ok(momSnap.get("approvedAt"), "첫 연결 때 approvedAt 기록");
assert.deepEqual(momSnap.get("linkedStudentIds"), sorted([s1, s2]));
await waitFor("결제 parentUids에 추가", async () =>
  ((await db.doc(`academies/${A}/payments/pay-s1`).get()).get("parentUids") ?? []).includes(mom.uid));
await waitFor("클레임 active", async () => (await adminAuth().getUser(mom.uid)).customClaims?.membershipStatus === "active");

// 같은 번호의 다른 계정은 연결 거부
const dupLink = call("linkParentToStudents", { academyId: A, parentUid: dup.uid, studentIds: [s3] });
await assert.rejects(dupLink, /이미 다른 학부모 계정에 연결/);

// 번호가 맞는 보호자가 없는 원생(원장이 직접 고름) → 계정 이름·번호로 보호자 추가
const linked3 = await call("linkParentToStudents", { academyId: A, parentUid: mom.uid, studentIds: [s3] });
assert.deepEqual(linked3.linked, [s3]);
let st3 = await studentDoc(s3);
assert.equal(st3.guardians.length, 2);
assert.equal(st3.guardians[1].phone, PHONE);
assert.equal(st3.guardians[1].name, "엄마");
assert.equal(st3.guardians[1].linkedParentUid, mom.uid);
// 다시 연결해도 그대로(이미 연결)
assert.deepEqual((await call("linkParentToStudents", { academyId: A, parentUid: mom.uid, studentIds: [s3] })).alreadyLinked, [s3]);

// --- 연결된 보호자 항목 삭제는 원생 저장으로 할 수 없다 ---
const s3Base = { academyId: A, studentId: s3, name: "다른 집", grade: "e3", status: "enrolled" };
await assert.rejects(
  call("saveStudent", { ...s3Base, guardians: [{ id: st3.guardians[0].id, relationId: "father", phone: "010-6666-7777" }] }),
  /앱에 연결된 보호자입니다/,
);
await assert.rejects(call("saveStudent", { ...s3Base, guardians: [] }), /앱에 연결된 보호자입니다/);
// 보호자 목록을 보내지 않으면 그대로(연결 유지)
await call("saveStudent", s3Base);
assert.deepEqual((await studentDoc(s3)).guardians, st3.guardians, "guardians 생략 = 변경 없음");
assert.deepEqual((await studentDoc(s3)).parentUids, [mom.uid]);

// 반 준비: 운영중 A반(시간 2칸, 순서 뒤)·준비중 B반(순서 앞)·종강 C반 — 형은 셋 다, 동생은 없음
const clsA = (await call("saveClass", {
  academyId: A, name: "A반", status: "active",
  schedule: [{ weekday: 3, start: "16:00", end: "17:00" }, { weekday: 1, start: "16:00", end: "17:00" }],
})).classId;
const clsB = (await call("saveClass", { academyId: A, name: "B반", status: "preparing" })).classId;
const clsC = (await call("saveClass", { academyId: A, name: "C반", status: "active" })).classId;
for (const c of [clsA, clsB, clsC]) await call("setClassStudents", { academyId: A, classId: c, add: [s1] });
await call("saveClass", { academyId: A, classId: clsC, status: "ended" });
await call("reorderClasses", { academyId: A, orderedIds: [clsB, clsA, clsC] });

// 연결된 학부모 앱에서 자녀 목록 — 반 이름·수업 시간만(종강 반 제외, 반 순서대로)
await asParent("momseven", "pw123456");
const momList = await call("listParentChildrenStudents", { academyId: A });
assert.equal(momList.accountStatus, "active");
assert.equal(momList.students.length, 3);
const listedS1 = momList.students.find((s) => s.id === s1);
assert.deepEqual(listedS1.classes, [
  { name: "B반", schedule: [] },
  { name: "A반", schedule: [{ weekday: 1, start: "16:00", end: "17:00" }, { weekday: 3, start: "16:00", end: "17:00" }] },
], "종강 반 제외·반 순서·요일 순");
for (const c of listedS1.classes) assert.deepEqual(Object.keys(c).sort(), ["name", "schedule"], "반 id·선생님·강의실·정원 없음");
assert.deepEqual(momList.students.find((s) => s.id === s2).classes, [], "반 없는 자녀는 빈 목록");

// --- 해제: 연결만 지우고 계정·보호자 연락처는 남김, 결제 parentUids에서 빠짐 ---
await asOwner();
await call("unlinkParentFromStudent", { academyId: A, parentUid: mom.uid, studentId: s1 });
const st1 = await studentDoc(s1);
assert.deepEqual(st1.parentUids, []);
assert.equal(st1.guardians.length, 1, "보호자 연락처는 남는다");
assert.equal(st1.guardians[0].linkedParentUid, null);
await waitFor("해제 → 결제 parentUids에서 빠짐", async () =>
  !((await db.doc(`academies/${A}/payments/pay-s1`).get()).get("parentUids") ?? []).includes(mom.uid));
await call("unlinkParentFromStudent", { academyId: A, parentUid: mom.uid, studentId: s2 });
await call("unlinkParentFromStudent", { academyId: A, parentUid: mom.uid, studentId: s3 });
await waitFor("마지막 해제 → pending_approval", async () => (await parentDoc(mom.uid)).get("status") === "pending_approval");
momSnap = await parentDoc(mom.uid);
assert.ok(momSnap.get("approvedAt"), "해제해도 approvedAt 유지(승인 대기 배지에 다시 잡히지 않음)");
assert.deepEqual(momSnap.get("linkedStudentIds"), []);
assert.equal((await db.doc(`academies/${A}/parentPhones/${PHONE_KEY}`).get()).get("parentUid"), mom.uid, "색인은 유지");
// 이미 잡고 있던 색인은 연결이 전부 실패해도 그대로
const momFail = await call("linkParentToStudents", { academyId: A, parentUid: mom.uid, studentIds: ["no-such-student"] });
assert.equal(momFail.failures.length, 1);
assert.equal((await db.doc(`academies/${A}/parentPhones/${PHONE_KEY}`).get()).get("parentUid"), mom.uid, "기존 색인 유지");

// --- 연결이 전부 실패하면 이번에 새로 잡은 색인은 되돌린다 ---
const SOLO_PHONE = "010-3030-4040";
const SOLO_KEY = "01030304040";
const solo = await selfSignupAndVerify("soloseven", "혼자", SOLO_PHONE);
await solo.verify();
await asOwner();
const soloFail = await call("linkParentToStudents", { academyId: A, parentUid: solo.uid, studentIds: ["no-such-student"] });
assert.deepEqual(soloFail.linked, []);
assert.equal(soloFail.failures.length, 1);
assert.equal((await db.doc(`academies/${A}/parentPhones/${SOLO_KEY}`).get()).exists, false, "전부 실패 → 색인 없음");
assert.equal((await parentDoc(solo.uid)).get("approvedAt"), null, "연결 0건이면 approvedAt도 그대로");
// 같은 계정에 대한 연결 2건 동시(한쪽은 전부 실패) → 연결된 쪽이 있으므로 색인이 남는다
const s4 = (await mk("넷째 집", [{ relationId: "mother", phone: SOLO_PHONE }])).studentId;
const [raceFail, raceOk] = await Promise.all([
  call("linkParentToStudents", { academyId: A, parentUid: solo.uid, studentIds: ["no-such-student"] }),
  call("linkParentToStudents", { academyId: A, parentUid: solo.uid, studentIds: [s4] }),
]);
assert.equal(raceFail.failures.length, 1);
assert.deepEqual(raceOk.linked, [s4]);
assert.deepEqual((await studentDoc(s4)).parentUids, [solo.uid]);
assert.equal((await db.doc(`academies/${A}/parentPhones/${SOLO_KEY}`).get()).get("parentUid"), solo.uid, "연결이 있으면 색인 유지");

// --- 연결 대기 계정 비밀번호 초기화 → 첫 로그인 → 다시 연결 대기(스스로 활성화 안 됨) ---
const reset = await call("resetMemberPassword", { academyId: A, memberAuthUid: mom.uid, role: "parent" });
assert.equal((await parentDoc(mom.uid)).get("status"), "pending_setup");
const resetLogin = await asParent("momseven", reset.tempPassword);
assert.equal(resetLogin.membershipStatus, "pending_setup");
const firstAfterReset = await call("completeMemberFirstLogin", { newPassword: "pw654321" });
assert.equal(firstAfterReset.membershipStatus, "pending_approval");
assert.equal((await parentDoc(mom.uid)).get("status"), "pending_approval");

// --- 직접 만들어 주기 → 첫 로그인 → active ---
await asOwner();
await assert.rejects(
  call("createParentAccount", { academyId: A, displayName: "중복", phone: PHONE, studentIds: [s1] }),
  /이미 다른 학부모 계정에 연결/,
);
const made = await call("createParentAccount", { academyId: A, displayName: "아빠", phone: "010-4444-5555", studentIds: [s2] });
assert.ok(made.tempPassword);
assert.deepEqual(made.linked, [s2]);
let dadSnap = await parentDoc(made.authUid);
assert.equal(dadSnap.get("status"), "pending_setup");
assert.ok(dadSnap.get("approvedAt"));
assert.equal(dadSnap.get("signupSource"), "academy_created");
assert.equal((await db.doc(`academies/${A}/parentPhones/01044445555`).get()).get("parentUid"), made.authUid);
assert.equal((await studentDoc(s2)).guardians[1].linkedParentUid, made.authUid, "아버지 번호 항목에 연결");
await waitFor("직접 만든 계정 요약", async () => ((await parentDoc(made.authUid)).get("linkedStudentIds") ?? []).length === 1);
assert.equal((await parentDoc(made.authUid)).get("status"), "pending_setup", "첫 로그인 전은 자동 전환하지 않음");
const dadLogin = await asParent(made.loginId, made.tempPassword);
assert.equal(dadLogin.membershipStatus, "pending_setup");
const dadFirst = await call("completeMemberFirstLogin", { newPassword: "dad12345" });
assert.equal(dadFirst.membershipStatus, "active");

// --- 비활성 계정: 연결 거부, 푸시 수신자 제외, 자동 전환과 겹쳐도 inactive 유지 ---
await asOwner();
await call("deactivateParent", { academyId: A, parentAuthUid: made.authUid });
assert.equal((await adminAuth().getUser(made.authUid)).disabled, true);
await assert.rejects(call("linkParentToStudents", { academyId: A, parentUid: made.authUid, studentIds: [s1] }), /비활성/);
assert.deepEqual((await studentDoc(s2)).parentUids, [made.authUid]);
const notify = await call("sendStudentAttendanceNotification", { academyId: A, studentId: s2, kind: "present" });
assert.equal(notify.reason, "no_parent", "비활성 보호자는 수신자에서 제외");
assert.equal((await db.collection(`users/${made.authUid}/dashboardBellItems`).get()).size, 0);
await call("unlinkParentFromStudent", { academyId: A, parentUid: made.authUid, studentId: s2 });
await waitFor("비활성 계정 요약 갱신", async () => ((await parentDoc(made.authUid)).get("linkedStudentIds") ?? []).length === 0);
assert.equal((await parentDoc(made.authUid)).get("status"), "inactive", "자동 전환이 비활성화를 덮어쓰지 않음");
// 비활성 계정 로그인 거부(커스텀 토큰 로그인이 Auth에서 막힘)
await signOut(auth);
const inactiveLogin = await call("signInParent", { loginId: made.loginId, password: "dad12345" });
await assert.rejects(signInWithCustomToken(auth, inactiveLogin.customToken), /user-disabled/);
// 재활성화 → 연결 0명이라 연결 대기
await asOwner();
const reactivated = await call("activateParent", { academyId: A, parentAuthUid: made.authUid });
assert.equal(reactivated.membershipStatus, "pending_approval");
assert.equal((await adminAuth().getUser(made.authUid)).disabled, false);

// --- 계정 삭제(가입 거절): 원생 유지·연결 해제·색인 해제·Auth 삭제, 지운 문서가 트리거로 되살아나지 않음 ---
await call("linkParentToStudents", { academyId: A, parentUid: mom.uid, studentIds: [s1] });
await waitFor("재연결 → active", async () => (await parentDoc(mom.uid)).get("status") === "active");
await call("deleteParentAccount", { academyId: A, parentUid: mom.uid });
assert.equal((await parentDoc(mom.uid)).exists, false);
const afterDelete = await studentDoc(s1);
assert.ok(afterDelete, "원생은 남는다");
assert.deepEqual(afterDelete.parentUids, []);
assert.equal(afterDelete.guardians[0].phone, PHONE, "보호자 연락처는 남는다");
assert.equal((await db.doc(`academies/${A}/parentPhones/${PHONE_KEY}`).get()).exists, false, "색인 해제");
await assert.rejects(adminAuth().getUser(mom.uid), /no user record/i);
await waitFor("결제 parentUids 정리", async () =>
  !((await db.doc(`academies/${A}/payments/pay-s1`).get()).get("parentUids") ?? []).includes(mom.uid));
await new Promise((r) => setTimeout(r, 1500));
assert.equal((await parentDoc(mom.uid)).exists, false, "트리거가 지운 계정 문서를 되살리지 않음");
// 색인이 풀려 같은 번호의 다른 계정을 연결할 수 있다
await call("linkParentToStudents", { academyId: A, parentUid: dup.uid, studentIds: [s1] });
await waitFor("다른 계정 연결 → active", async () => (await parentDoc(dup.uid)).get("status") === "active");
await waitFor("결제 parentUids에 새 계정", async () =>
  ((await db.doc(`academies/${A}/payments/pay-s1`).get()).get("parentUids") ?? []).includes(dup.uid));

// --- 학생 삭제: 결제 parentUids는 마지막 값을 그대로(실제 납부 기록) ---
await call("deleteAcademyStudent", { academyId: A, studentId: s1 });
await waitFor("학생 삭제 → 계정 요약 갱신", async () => ((await parentDoc(dup.uid)).get("linkedStudentIds") ?? []).length === 0);
assert.deepEqual((await db.doc(`academies/${A}/payments/pay-s1`).get()).get("parentUids"), [dup.uid]);
assert.equal((await parentDoc(dup.uid)).get("status"), "pending_approval");

console.log("SMOKE OK");
process.exit(0);
