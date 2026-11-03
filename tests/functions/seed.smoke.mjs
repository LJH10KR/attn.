/**
 * seed 스모크(2-H) — `npm run test:functions` (Auth·Firestore·Functions 에뮬레이터)
 * `createSeedBatch`: 2단계 모델(원생·학부모·반·색인·관계·meta/seq) + 직원·학부모가 로그인 ID로 실제 로그인됨(승인 대기 포함).
 * `deleteSeedBatch`: 학원 cascade(멤버 로그인 정보·색인·알림 기록·_pushDeliveries) + seed만 결제까지 삭제,
 * Auth·users 정리(admin 계정은 남김), 다른 학원 데이터는 그대로.
 */
import assert from "node:assert/strict";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb, Timestamp } from "firebase-admin/firestore";
import { deleteApp, initializeApp } from "firebase/app";
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
const SEED_ID = "seedqa_1";
const OTHER = "o11_other";

const adminUser = await adminAuth().createUser({ email: "admin11@t.dev", password: "pass1234", emailVerified: true });
await adminAuth().setCustomUserClaims(adminUser.uid, { admin: true });
await db.doc(`users/${adminUser.uid}`).set({ displayName: "관리자" });
// 지우면 안 되는 다른 학원 데이터
await db.doc(`academies/${OTHER}`).set({ ownerUid: "someone", name: "다른 학원" });
await db.doc(`_pushDeliveries/other-1`).set({ academyId: OTHER, recipientUid: "x" });

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);

await signInWithEmailAndPassword(auth, "admin11@t.dev", "pass1234");
await auth.currentUser.getIdToken(true);

// 반당 선생님 수 > 선생님 수 → 거부 문구
await assert.rejects(
  call("createSeedBatch", { academyId: "seedqa_bad", teachersCount: 1, teachersPerStudent: 2 }),
  /반당 선생님 수는 선생님 수보다 클 수 없습니다/,
);

const made = await call("createSeedBatch", {
  label: "seed qa", academyId: SEED_ID, teachersCount: 2, parentsCount: 2, studentsPerParent: 2, teachersPerStudent: 1,
});
assert.equal(made.academyId, SEED_ID);
const { credentials } = made;
assert.equal(credentials.teachers.length, 2);
assert.equal(credentials.parents.length, 2);
assert.equal(credentials.pendingParents.length, 2);
for (const m of [...credentials.teachers, ...credentials.parents, ...credentials.pendingParents]) {
  assert.ok(m.loginId && m.password, "로그인 ID·비밀번호 표시");
  assert.equal("email" in m, false, "직원·학부모는 이메일이 아니라 로그인 ID");
}

// --- 모델 확인 ---
const A = `academies/${SEED_ID}`;
const staff = await db.collection(`${A}/staff`).get();
assert.equal(staff.size, 2);
for (const s of staff.docs) {
  assert.ok(s.get("attnId") && s.get("loginId"));
  assert.equal(s.get("status"), "active");
  assert.equal(s.get("authProvider"), "password");
  assert.ok((await db.doc(`${A}/staff/${s.id}/secrets/login`).get()).get("passwordHash"), "로그인 비밀번호 해시");
  assert.equal((await db.doc(`attnLoginIndex/${s.get("loginId")}`).get()).get("authUid"), s.id, "로그인 색인");
  const u = await adminAuth().getUser(s.id);
  assert.equal(u.customClaims?.role, "teacher");
  assert.match(u.email ?? "", /@provision\.attndot\.internal$/, "내부 이메일");
}
const parents = await db.collection(`${A}/parents`).get();
assert.equal(parents.size, 4);
const pendings = parents.docs.filter((d) => d.get("status") === "pending_approval");
assert.equal(pendings.length, 2);
assert.ok(pendings.every((d) => d.get("approvedAt") === null));
const linked = parents.docs.filter((d) => d.get("status") === "active");
for (const p of linked) {
  assert.ok(p.get("approvedAt"), "연결 계정 approvedAt");
  assert.equal(
    (await db.doc(`${A}/parentPhones/${p.get("phone").replace(/\D/g, "")}`).get()).get("parentUid"),
    p.id,
    "번호 색인",
  );
}
const students = await db.collection(`${A}/students`).get();
assert.equal(students.size, 4);
for (const s of students.docs) {
  assert.ok(s.get("grade") && s.get("status") && Array.isArray(s.get("guardians")));
  assert.ok(Array.isArray(s.get("classIds")) && Array.isArray(s.get("teacherUids")) && Array.isArray(s.get("parentUids")));
}
assert.equal((await db.collection(`${A}/classes`).get()).size, 3);
assert.ok((await db.collection(`${A}/studentNotes`).get()).size >= 1);
const seq = (await db.doc(`${A}/meta/seq`).get()).data();
assert.deepEqual([seq.nextTeacherSeq, seq.nextParentSeq, seq.nextStudentSeq], [3, 5, 5]);
const options = (await db.doc(`${A}/meta/options`).get()).data();
assert.ok(options.guardianRelations.length > 0 && options.rooms.length === 2);

// --- 실제 로그인 ---
async function loginAs(fn, loginId, password) {
  const d = initializeApp({ projectId: PROJECT, apiKey: "fake" }, `seed-${fn}-${loginId}`);
  const a = getAuth(d);
  connectAuthEmulator(a, "http://127.0.0.1:9099", { disableWarnings: true });
  const f = getFunctions(d, "asia-northeast3");
  connectFunctionsEmulator(f, "127.0.0.1", 5001);
  const res = (await httpsCallable(f, fn)({ loginId, password })).data;
  await signInWithCustomToken(a, res.customToken);
  const token = await a.currentUser.getIdTokenResult(true);
  await deleteApp(d);
  return { res, claims: token.claims };
}
const t = await loginAs("signInTeacher", credentials.teachers[0].loginId, credentials.teachers[0].password);
assert.equal(t.res.membershipStatus, "active");
const p = await loginAs("signInParent", credentials.parents[0].loginId, credentials.parents[0].password);
assert.equal(p.res.membershipStatus, "active");
const pp = await loginAs("signInParent", credentials.pendingParents[0].loginId, credentials.pendingParents[0].password);
assert.equal(pp.res.membershipStatus, "pending_approval");

// --- 삭제 대상 데이터 추가(QA 중 생기는 것) ---
const ownerUid = (await db.doc(A).get()).get("ownerUid");
const teacherUid = staff.docs[0].id;
await db.doc(`${A}/payments/pay-1`).set({ studentId: students.docs[0].id, amount: 1000, createdAt: Timestamp.now() });
await db.doc(`${A}/attendanceNotifications/n-1`).set({ studentId: students.docs[0].id, createdAt: Timestamp.now() });
await db.doc(`${A}/adminInbox/i-1`).set({ kind: "x" });
await db.doc(`_pushDeliveries/seed-1`).set({ academyId: SEED_ID, recipientUid: linked[0].id });
await db.doc(`users/${ownerUid}`).set({ displayName: "seed 원장" }, { merge: true });
await db.doc(`users/${teacherUid}`).set({ displayName: "seed 선생님" }, { merge: true });

await signOut(auth);
await signInWithEmailAndPassword(auth, "admin11@t.dev", "pass1234");
const del = await call("deleteSeedBatch", { seedBatchId: made.seedBatchId });
assert.equal(del.ok, true);

// --- 삭제 확인 ---
assert.equal((await db.doc(A).get()).exists, false);
for (const sub of [
  "staff", "parents", "students", "classes", "classHistory", "parentPhones", "studentNotes",
  "meta", "roles", "adminInbox", "attendanceNotifications", "payments",
]) {
  const left = (await db.collection(`${A}/${sub}`).get()).docs.map((d) => d.id);
  assert.deepEqual(left, [], `${sub} 삭제`);
}
assert.equal((await db.doc(`${A}/staff/${teacherUid}/secrets/login`).get()).exists, false, "멤버 로그인 비밀번호 삭제");
for (const m of [...credentials.teachers, ...credentials.parents, ...credentials.pendingParents]) {
  assert.equal((await db.doc(`attnLoginIndex/${m.loginId}`).get()).exists, false, "로그인 색인 삭제");
}
assert.equal((await db.doc(`_pushDeliveries/seed-1`).get()).exists, false, "seed 학원 푸시 전달 삭제");
assert.equal((await db.doc(`_pushDeliveries/other-1`).get()).exists, true, "다른 학원 푸시 전달 유지");
assert.equal((await db.doc(`academies/${OTHER}`).get()).exists, true, "다른 학원 유지");
await assert.rejects(adminAuth().getUser(ownerUid), /no user record/i);
await assert.rejects(adminAuth().getUser(teacherUid), /no user record/i);
assert.equal((await db.doc(`users/${ownerUid}`).get()).exists, false, "원장 users 정리(남은 소유 학원 없음)");
assert.equal((await db.doc(`users/${teacherUid}`).get()).exists, false, "직원 users 정리");
assert.equal((await db.doc(`users/${adminUser.uid}`).get()).exists, true, "admin 계정 데이터 유지");
await adminAuth().getUser(adminUser.uid);
// 다시 지우면 이미 삭제됨
assert.equal((await call("deleteSeedBatch", { seedBatchId: made.seedBatchId })).alreadyDeleted, true);

// --- 삭제 트리거(집계·inbox·활성 미러)가 다 돈 뒤에도 다시 생기지 않음 ---
const seedUids = [
  ownerUid,
  ...staff.docs.map((d) => d.id),
  ...parents.docs.map((d) => d.id),
];
async function leftovers() {
  const out = [];
  for (const sub of ["meta", "adminInbox"]) {
    for (const d of (await db.collection(`${A}/${sub}`).get()).docs) out.push(`${sub}/${d.id}`);
  }
  for (const uid of seedUids) {
    if ((await db.doc(`users/${uid}`).get()).exists) out.push(`users/${uid}`);
    for (const d of (await db.collection(`users/${uid}/serverMirror`).get()).docs) out.push(`users/${uid}/serverMirror/${d.id}`);
  }
  return out;
}
// 8초 동안 1초마다 확인(트리거는 삭제 뒤 수백 ms 안에 돈다)
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  assert.deepEqual(await leftovers(), [], `삭제 ${i + 1}초 뒤 다시 생긴 문서 없음`);
}

// --- 원장이 다른 학원을 하나 더 가진 경우: 학원 하나를 지워도 원장 Auth·users 유지(adminDeleteAcademyCascade) ---
const twoOwner = await adminAuth().createUser({ email: "owner11b@t.dev", password: "pass1234", emailVerified: true });
await db.doc(`users/${twoOwner.uid}`).set({ displayName: "학원 둘 원장", platformRole: "owner" });
await db.doc("academies/o11_first").set({ ownerUid: twoOwner.uid, name: "첫 학원" });
await db.doc("academies/o11_second").set({ ownerUid: twoOwner.uid, name: "둘째 학원" });
await call("adminDeleteAcademyCascade", { academyId: "o11_first" });
assert.equal((await db.doc("academies/o11_first").get()).exists, false);
await adminAuth().getUser(twoOwner.uid); // 남아 있어야 함
assert.equal((await db.doc(`users/${twoOwner.uid}`).get()).exists, true, "다른 학원이 남은 원장 users 유지");
// 마지막 학원까지 지우면 원장 Auth·users 정리
await call("adminDeleteAcademyCascade", { academyId: "o11_second" });
await assert.rejects(adminAuth().getUser(twoOwner.uid), /no user record/i);
assert.equal((await db.doc(`users/${twoOwner.uid}`).get()).exists, false, "마지막 학원 삭제 뒤 원장 users 정리");

console.log("SMOKE OK");
process.exit(0);
