/**
 * 원생 여러 명 입력 표(2-M, `createStudentsBulk`) 통합 스모크 — `npm run test:functions`.
 * 200줄 경계(201 거부), 줄마다 성공/실패(학년·번호·지운 관계·종강 반·동명이인 → 확인 후 저장), 학생 번호 연속,
 * 파생 필드(guardianPhones·parentUids·classIds·teacherUids)·반 이력, 학생 트리거 자동 연결(연결 1번·벨 1건),
 * 반 권한 없는 직원은 반 칸 줄만 실패, 권한 없음 거부, 200줄 저장 소요 시간·트리거 정착(B1).
 */
import assert from "node:assert/strict";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { CONSENTS, seedSignupToken } from "./_signup-token.mjs";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A = "o20_a1";
const nowYear = new Date(Date.now() + 9 * 3600 * 1000).getUTCFullYear();

for (const d of (await db.collection("phoneVerificationCounters").get()).docs) {
  if (d.id.startsWith("ip_hr_")) await d.ref.delete();
}

const owner = await adminAuth().createUser({ email: "owner20@t.dev", password: "pass1234", emailVerified: true });
const stuOnly = await adminAuth().createUser({ email: "stu20@t.dev", password: "pass1234" });
await adminAuth().createUser({ email: "nobody20@t.dev", password: "pass1234" });
const teacher = await adminAuth().createUser({ email: "t20@t.dev", password: "pass1234" });
await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "표 입력 학원", status: "active" });
await db.doc(`academies/${A}/meta/seq`).set({ nextTeacherSeq: 1, nextParentSeq: 1, nextStudentSeq: 1 });
await db.doc(`academies/${A}/meta/options`).set({
  guardianRelations: [{ id: "mother", label: "어머니" }, { id: "father", label: "아버지" }],
});
await db.doc(`academies/${A}/staff/${stuOnly.uid}`).set({
  authUid: stuOnly.uid, displayName: "원생 담당", status: "active", roleId: "x", permissions: ["operations.students"],
});
await db.doc(`academies/${A}/staff/${teacher.uid}`).set({
  authUid: teacher.uid, displayName: "수학 선생님", status: "active", roleId: "y", permissions: [],
});
await db.doc(`academies/${A}/classes/c_math`).set({ name: "수학A", status: "active", teacherUids: [teacher.uid], sortOrder: 0 });
await db.doc(`academies/${A}/classes/c_sci`).set({ name: "과학", status: "ended", teacherUids: [], sortOrder: 1 });
await db.doc(`academies/${A}/students/existing1`).set({
  name: "기존학생", grade: "e3", gradeYear: nowYear, status: "enrolled", guardians: [], guardianPhones: [], parentUids: [],
  classIds: [], teacherUids: [],
});
const P = await seedSignupToken(db, A, "parent");

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name, { timeout: 180_000 })(data).then((r) => r.data);
const as = async (email) => {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, email, "pass1234");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, check, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new Error(`시간 초과: ${label}`);
    await sleep(300);
  }
}
const student = async (id) => (await db.doc(`academies/${A}/students/${id}`).get()).data();
const row = (rowKey, patch = {}) => ({
  rowKey, name: `학생-${rowKey}`, grade: "e3", school: "", guardians: [], classId: null, allowDuplicate: false, ...patch,
});
const bulk = (rows) => call("createStudentsBulk", { academyId: A, rows });

// --- 권한·크기 ---
await as("nobody20@t.dev");
await assert.rejects(bulk([row("x")]), /권한/);
await as("owner20@t.dev");
await assert.rejects(bulk([]), /저장할 원생이 없습니다/);
await assert.rejects(bulk(Array.from({ length: 201 }, (_, i) => row(`r${i}`))), /200명까지/);
await assert.rejects(bulk([row("dup"), row("dup")]), /표 줄 정보/);

// --- 줄마다 성공/실패 ---
const r1 = await bulk([
  row("ok1", {
    name: "김가나", school: "가나초",
    guardians: [{ relationId: "mother", phone: "010-3100-0001" }, { relationId: null, phone: "01031000002" }],
    classId: "c_math",
  }),
  row("badGrade", { grade: "x9" }),
  row("badPhone", { guardians: [{ relationId: null, phone: "02-123-4567" }] }),
  row("goneRel", { guardians: [{ relationId: "uncle", phone: "010-3100-0003" }] }),
  row("ended", { classId: "c_sci" }),
  row("samePhone", { guardians: [{ relationId: null, phone: "010-3100-0004" }, { relationId: null, phone: "01031000004" }] }),
  row("dupExisting", { name: "기존학생", grade: "e3" }),
  row("dupAllowed", { name: "기존학생", grade: "e3", allowDuplicate: true }),
  row("ok2", { name: "이다라", grade: "h1" }),
]);
const byKey = Object.fromEntries(r1.results.map((r) => [r.rowKey, r]));
assert.equal(r1.createdCount, 3);
assert.equal(r1.failedCount, 6);
assert.equal(byKey.ok1.ok, true);
assert.equal(byKey.ok1.classAssigned, true);
assert.match(byKey.badGrade.message, /학년/);
assert.match(byKey.badPhone.message, /번호 형식/);
assert.match(byKey.goneRel.message, /관계가 삭제/);
assert.match(byKey.ended.message, /종강/);
assert.match(byKey.samePhone.message, /두 번/);
assert.equal(byKey.dupExisting.code, "duplicate");
assert.equal(byKey.dupAllowed.ok, true, "동명이인 확인 후 저장");
assert.equal(byKey.ok2.ok, true);
// 학생 번호 연속(성공 3줄 = 1·2·3)
assert.deepEqual([byKey.ok1.attnId, byKey.dupAllowed.attnId, byKey.ok2.attnId].sort(), [`${A}_s1`, `${A}_s2`, `${A}_s3`]);
assert.equal((await db.doc(`academies/${A}/meta/seq`).get()).get("nextStudentSeq"), 4);

const s1 = await student(byKey.ok1.studentId);
assert.equal(s1.name, "김가나");
assert.equal(s1.school, "가나초");
assert.equal(s1.grade, "e3");
assert.equal(s1.gradeYear, nowYear);
assert.equal(s1.status, "enrolled");
assert.deepEqual(s1.guardianPhones, ["01031000001", "01031000002"]);
assert.deepEqual(s1.parentUids, []);
assert.equal(s1.guardians[0].isPrimary, true);
assert.equal(s1.guardians[0].relationId, "mother");
assert.equal(s1.guardians[0].linkedParentUid, null);
assert.deepEqual(s1.classIds, ["c_math"]);
assert.deepEqual(s1.teacherUids, [teacher.uid], "반 담당 선생님 파생");
assert.equal(s1.createdByUid, owner.uid);
const hist = await db.collection(`academies/${A}/classHistory`).where("classId", "==", "c_math").get();
assert.equal(hist.size, 1);
assert.equal(hist.docs[0].get("type"), "students_added");
assert.deepEqual(hist.docs[0].get("studentIds"), [byKey.ok1.studentId]);

// 표 안에서 같은 이름·학년 — 첫 줄은 저장, 확인 없는 둘째는 duplicate
const r2 = await bulk([row("t1", { name: "쌍둥이", grade: "m1" }), row("t2", { name: "쌍둥이", grade: "m1" })]);
assert.equal(r2.results[0].ok, true);
assert.equal(r2.results[1].code, "duplicate");

// --- 반 권한 없는 직원: 반 칸 줄만 실패 ---
await as("stu20@t.dev");
const r3 = await bulk([row("s1", { classId: "c_math" }), row("s2")]);
assert.equal(r3.results[0].code, "class_permission");
assert.equal(r3.results[1].ok, true);

// --- 학생 트리거 자동 연결: 번호를 확인하고 기다리던 학부모 → 표로 원생 저장 → 연결 1번·벨 1건 ---
await signOut(auth);
const WAIT = "010-3100-0100";
const st = await call("startPhoneVerification", { purpose: "parent_signup", token: P, phone: WAIT });
const ck = await call("checkPhoneVerification", { verificationId: st.verificationId });
assert.equal(ck.status, "verified");
const pj = await call("registerParentSelfSignup", {
  token: P, loginId: "bulkwait1", displayName: "기다리는 학부모", phone: WAIT, password: "pw123456",
  consents: CONSENTS, phoneProof: ck.proof,
});
assert.equal(pj.membershipStatus, "pending_approval");
assert.equal(pj.linkedCount, 0);
const parentUid = (await db.doc("attnLoginIndex/bulkwait1").get()).get("authUid");
await as("owner20@t.dev");
const r4 = await bulk([
  row("kid1", { name: "연결첫째", guardians: [{ relationId: "mother", phone: WAIT }] }),
  row("kid2", { name: "연결둘째", grade: "e1", guardians: [{ relationId: null, phone: "01031000100" }] }),
]);
const kids = r4.results.map((r) => r.studentId);
await waitFor("자동 연결", async () => {
  const docs = await Promise.all(kids.map(student));
  return docs.every((d) => d.parentUids?.includes(parentUid));
});
for (const id of kids) {
  const d = await student(id);
  assert.equal(d.guardians[0].linkedParentUid, parentUid);
}
await waitFor("학부모 사용 중", async () => (await db.doc(`academies/${A}/parents/${parentUid}`).get()).get("status") === "active");
await sleep(3000);
for (const id of kids) {
  const b = await db.doc(`academies/${A}/adminInbox/p-autolink-${parentUid}-${id}`).get();
  assert.equal(b.exists, true, "벨");
}
const autoBells = await db.collection(`academies/${A}/adminInbox`).where("kind", "==", "parent_auto_linked").get();
assert.equal(autoBells.size, 2, "원생마다 벨 1건");
assert.equal((await student(kids[0])).parentUids.length, 1, "연결 1번");

// --- 200줄(B1) — 함수 소요 시간·트리거 정착 ---
const before = (await db.collection(`academies/${A}/students`).count().get()).data().count;
const big = Array.from({ length: 200 }, (_, i) =>
  row(`big${i}`, {
    name: `대량${String(i).padStart(3, "0")}`,
    grade: ["e1", "e4", "m2", "h3"][i % 4],
    guardians: [{ relationId: "mother", phone: `010-32${String(i).padStart(2, "0").slice(-2)}-${String(1000 + i)}` }],
    classId: i % 10 === 0 ? "c_math" : null,
  }),
);
const t0 = Date.now();
const rBig = await bulk(big);
const callMs = Date.now() - t0;
assert.equal(rBig.createdCount, 200, JSON.stringify(rBig.results.filter((r) => !r.ok).slice(0, 3)));
assert.equal(rBig.results.filter((r) => r.classAssigned).length, 20);
assert.equal(new Set(rBig.results.map((r) => r.attnId)).size, 200, "학생 번호 겹침 없음");
assert.equal((await db.collection(`academies/${A}/students`).count().get()).data().count, before + 200);
const t1 = Date.now();
await waitFor(
  "대시보드 집계 정착",
  async () => (await db.doc(`academies/${A}/meta/dashboardStats`).get()).get("students") === before + 200,
  120_000,
);
const settleMs = Date.now() - t1;
const bigHist = await db.collection(`academies/${A}/classHistory`).where("classId", "==", "c_math").get();
assert.ok(bigHist.docs.some((d) => (d.get("studentIds") ?? []).length === 20), "200줄 반 배정 이력 1건(20명)");
console.log(`[B1] createStudentsBulk 200줄: 호출 ${callMs}ms, 대시보드 집계 정착 +${settleMs}ms`);

await signOut(auth);
console.log("SMOKE OK students-bulk");
process.exit(0);
