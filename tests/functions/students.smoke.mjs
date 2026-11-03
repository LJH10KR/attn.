/**
 * 원생 Callable 통합 스모크 — `npm run test:functions` (Auth·Firestore·Functions 에뮬레이터)
 * saveStudent(생성·수정·검증·학년 유지·상태 시각·attnId·메모·보호자 연결 보존·보호자 생략 시 변경 없음·
 * 지운 관계 선택지는 새로 고른 값만 거부), deleteAcademyStudent,
 * 권한 거부, 상태 제외(출결 알림·키오스크), 출결 알림 수신자(활성 보호자만)를 확인한다.
 */
import assert from "node:assert/strict";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A = "o6_a1";
const thisYear = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear();

const owner = await adminAuth().createUser({ email: "owner6@t.dev", password: "pass1234", emailVerified: true });
const studentsStaff = await adminAuth().createUser({ email: "stu6@t.dev", password: "pass1234" });
const attendanceStaff = await adminAuth().createUser({ email: "att6@t.dev", password: "pass1234" });
await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "학원" });
await db.doc(`academies/${A}/staff/${studentsStaff.uid}`).set({
  authUid: studentsStaff.uid, displayName: "원생 담당", status: "active", roleId: "x", permissions: ["operations.students"],
});
await db.doc(`academies/${A}/staff/${attendanceStaff.uid}`).set({
  authUid: attendanceStaff.uid, displayName: "출결 담당", status: "active", roleId: "x", permissions: ["lessons.attendance"],
});
await db.doc(`academies/${A}/meta/options`).set({
  guardianRelations: [{ id: "mother", label: "어머니" }, { id: "father", label: "아버지" }],
});
// 연결 보호자 계정(2-C 연결 함수 대신 Admin으로 준비)
await db.doc(`academies/${A}/parents/p-active`).set({ authUid: "p-active", displayName: "엄마", status: "active" });
await db.doc(`academies/${A}/parents/p-inactive`).set({ authUid: "p-inactive", displayName: "아빠", status: "inactive" });

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);
const studentDoc = async (id) => (await db.doc(`academies/${A}/students/${id}`).get()).data();

await signInWithEmailAndPassword(auth, "owner6@t.dev", "pass1234");

// --- 생성: attnId·파생 필드·대표 보호자 자동·메모 분리 ---
const created = await call("saveStudent", {
  academyId: A, name: "김하나", grade: "e3", school: "한빛초", status: "enrolled",
  firstAttendedOn: "2026-03-02", memo: "알레르기 있음",
  guardians: [
    { relationId: "mother", name: "엄마", phone: "01011112222" },
    { relationId: "father", phone: "010-3333-4444" },
  ],
});
assert.equal(created.attnId, `${A}_s1`);
let s1 = await studentDoc(created.studentId);
assert.equal(s1.grade, "e3");
assert.equal(s1.gradeYear, thisYear);
assert.equal(s1.guardians.length, 2);
assert.equal(s1.guardians[0].phone, "010-1111-2222");
assert.equal(s1.guardians[0].isPrimary, true, "대표 지정이 없으면 첫 번째가 대표");
assert.deepEqual(s1.guardianPhones, ["01011112222", "01033334444"]);
assert.deepEqual(s1.parentUids, []);
assert.deepEqual(s1.classIds, []);
assert.deepEqual(s1.teacherUids, []);
assert.equal(s1.memo, undefined, "메모는 학생 문서에 두지 않는다");
assert.equal((await db.doc(`academies/${A}/studentNotes/${created.studentId}`).get()).get("memo"), "알레르기 있음");
assert.ok(s1.statusChangedAt, "생성 시 상태 시각 기록");
assert.equal((await db.doc(`academies/${A}/meta/seq`).get()).get("nextStudentSeq"), 2);

// 클라이언트가 보낸 연결 uid·파생 필드는 무시
const second = await call("saveStudent", {
  academyId: A, name: "이둘", grade: "m1", status: "enrolled",
  parentUids: ["hack"], classIds: ["c1"], teacherUids: ["t1"],
  guardians: [{ phone: "010-5555-6666", linkedParentUid: "hack" }],
});
assert.equal(second.attnId, `${A}_s2`);
const s2 = await studentDoc(second.studentId);
assert.deepEqual(s2.parentUids, []);
assert.deepEqual(s2.classIds, []);
assert.equal(s2.guardians[0].linkedParentUid, null);

// --- 수정: 연결은 저장된 값에서만 이어받는다 ---
const [gMother, gFather] = s1.guardians;
await db.doc(`academies/${A}/students/${created.studentId}`).update({
  guardians: [{ ...gMother, linkedParentUid: "p-active" }, { ...gFather, linkedParentUid: "p-inactive" }],
  parentUids: ["p-active", "p-inactive"],
});
await call("saveStudent", {
  academyId: A, studentId: created.studentId, name: "김하나", grade: "e3", status: "enrolled",
  guardians: [
    { id: gMother.id, relationId: "mother", name: "엄마(수정)", phone: "010-1111-2222", linkedParentUid: "hack" },
    { id: gFather.id, relationId: "father", phone: "010-3333-4444" },
    { id: "g_forgedid1", phone: "010-7777-8888", isPrimary: false },
  ],
});
s1 = await studentDoc(created.studentId);
assert.equal(s1.guardians[0].name, "엄마(수정)");
assert.equal(s1.guardians[0].linkedParentUid, "p-active");
assert.equal(s1.guardians[1].linkedParentUid, "p-inactive");
assert.notEqual(s1.guardians[2].id, "g_forgedid1", "모르는 id는 새 보호자로");
assert.equal(s1.guardians[2].linkedParentUid, null);
assert.deepEqual(s1.parentUids, ["p-active", "p-inactive"]);

// --- 출결 알림 수신자: 활성 보호자만(비활성은 parentUids에 있어도 제외) ---
const notify = await call("sendStudentAttendanceNotification", {
  academyId: A, studentId: created.studentId, kind: "present",
});
assert.equal(notify.ok, true);
const notifSnap = await db.collection(`academies/${A}/attendanceNotifications`)
  .where("studentId", "==", created.studentId).get();
assert.equal(notifSnap.size, 1);
assert.deepEqual(notifSnap.docs[0].get("parentUids"), ["p-active"]);
assert.equal((await db.collection("users/p-active/dashboardBellItems").get()).size, 1);
assert.equal((await db.collection("users/p-inactive/dashboardBellItems").get()).size, 0);

// 앱에 연결된 보호자 항목은 지울 수 없다(연결 해제는 학부모 관리 권한의 unlinkParentFromStudent만)
const saveBase = { academyId: A, studentId: created.studentId, name: "김하나", grade: "e3", status: "enrolled" };
await assert.rejects(
  call("saveStudent", { ...saveBase, guardians: [{ id: gFather.id, relationId: "father", phone: "010-3333-4444" }] }),
  /앱에 연결된 보호자입니다/,
);
await assert.rejects(
  call("saveStudent", { ...saveBase, guardians: [] }),
  /앱에 연결된 보호자입니다/,
  "빈 목록([] = 모두 삭제)도 연결된 항목이 있으면 거부",
);
// 보호자 목록을 보내지 않으면 그대로 둔다(연결 유지)
const guardiansBefore = (await studentDoc(created.studentId)).guardians;
await call("saveStudent", saveBase);
assert.deepEqual((await studentDoc(created.studentId)).guardians, guardiansBefore, "guardians 생략 = 변경 없음");
assert.deepEqual((await studentDoc(created.studentId)).parentUids, ["p-active", "p-inactive"]);
// 연결된 항목의 번호·이름 수정은 허용(연결 유지)
await call("saveStudent", {
  ...saveBase,
  guardians: [
    { id: gMother.id, relationId: "mother", name: "엄마", phone: "010-1111-9999" },
    { id: gFather.id, relationId: "father", phone: "010-3333-4444" },
  ],
});
s1 = await studentDoc(created.studentId);
assert.equal(s1.guardians[0].phone, "010-1111-9999");
assert.equal(s1.guardians[0].linkedParentUid, "p-active");
assert.equal(s1.guardians.length, 2, "연결 안 된 항목은 지울 수 있다");
// 연결을 해제한 뒤에는 지울 수 있다
await call("unlinkParentFromStudent", { academyId: A, parentUid: "p-active", studentId: created.studentId });
await call("saveStudent", { ...saveBase, guardians: [{ id: gFather.id, relationId: "father", phone: "010-3333-4444" }] });
s1 = await studentDoc(created.studentId);
assert.deepEqual(s1.parentUids, ["p-inactive"]);
assert.equal(s1.guardians[0].isPrimary, true);
await call("unlinkParentFromStudent", { academyId: A, parentUid: "p-inactive", studentId: created.studentId });

// --- 지운 관계 선택지: 기존 항목의 관계 id가 그대로면 통과, 새로 고른 값만 거부 ---
await db.doc(`academies/${A}/meta/options`).set({ guardianRelations: [{ id: "mother", label: "어머니" }] });
const fatherOnly = { id: gFather.id, relationId: "father", name: "아빠", phone: "010-3333-4444" };
await call("saveStudent", { ...saveBase, name: "김하나(수정)", guardians: [fatherOnly] });
s1 = await studentDoc(created.studentId);
assert.equal(s1.name, "김하나(수정)", "관계 선택지가 지워져도 다른 필드 저장");
assert.equal(s1.guardians[0].relationId, "father", "바뀌지 않은 관계 id는 그대로 남김");
assert.equal(s1.guardians[0].name, "아빠");
await assert.rejects(
  call("saveStudent", { ...saveBase, guardians: [fatherOnly, { relationId: "father", phone: "010-4444-5555" }] }),
  /관계가 삭제/,
  "새 항목에 지운 관계는 거부",
);
await call("saveStudent", { ...saveBase, guardians: [{ ...fatherOnly, relationId: "mother" }] });
await assert.rejects(
  call("saveStudent", { ...saveBase, guardians: [{ ...fatherOnly, relationId: "father" }] }),
  /관계가 삭제/,
  "기존 항목이라도 지운 관계로 바꾸면 거부",
);
assert.equal((await studentDoc(created.studentId)).guardians[0].relationId, "mother");
await db.doc(`academies/${A}/meta/options`).set({
  guardianRelations: [{ id: "mother", label: "어머니" }, { id: "father", label: "아버지" }],
});

// --- 학년: 화면이 보낸 "지금 학년"이 저장 값의 표시 학년과 같으면 기준 연도 유지 ---
await db.doc(`academies/${A}/students/${created.studentId}`).update({ gradeYear: thisYear - 1 });
const base = { academyId: A, studentId: created.studentId, name: "김하나", status: "enrolled" };
await call("saveStudent", { ...base, grade: "e4" });
s1 = await studentDoc(created.studentId);
assert.equal(s1.grade, "e3");
assert.equal(s1.gradeYear, thisYear - 1);
await call("saveStudent", { ...base, grade: "e5" });
s1 = await studentDoc(created.studentId);
assert.equal(s1.grade, "e5");
assert.equal(s1.gradeYear, thisYear);

// --- 상태: 바뀔 때만 statusChangedAt 갱신, 메모는 보낼 때만 갱신 ---
const before = s1.statusChangedAt.toMillis();
await call("saveStudent", { ...base, grade: "e5", memo: "휴원 상담" , status: "on_leave" });
s1 = await studentDoc(created.studentId);
assert.equal(s1.status, "on_leave");
assert.ok(s1.statusChangedAt.toMillis() > before);
const changedAt = s1.statusChangedAt.toMillis();
await call("saveStudent", { ...base, grade: "e5", status: "on_leave" });
assert.equal((await studentDoc(created.studentId)).statusChangedAt.toMillis(), changedAt);
assert.equal((await db.doc(`academies/${A}/studentNotes/${created.studentId}`).get()).get("memo"), "휴원 상담");

// --- 상태 제외: 휴원 원생은 출결 알림·키오스크 체크인 거부 ---
await assert.rejects(
  call("sendStudentAttendanceNotification", { academyId: A, studentId: created.studentId, kind: "present" }),
  /재원/,
);
await assert.rejects(
  call("submitKioskCheckIn", { academyId: A, studentId: created.studentId }),
  /재원/,
);

// --- 검증 ---
const bad = (patch) => call("saveStudent", { academyId: A, name: "x", grade: "e1", status: "enrolled", ...patch });
await assert.rejects(bad({ guardians: [{ phone: "010-1111-2222" }, { phone: "01011112222" }] }), /같은 번호/);
await assert.rejects(
  bad({ guardians: [{ phone: "010-1111-2222", isPrimary: true }, { phone: "010-2222-3333", isPrimary: true }] }),
  /대표/,
);
await assert.rejects(bad({ guardians: [{ phone: "010-1111-2222", relationId: "gone" }] }), /관계/);
await assert.rejects(
  bad({ guardians: Array.from({ length: 6 }, (_, i) => ({ phone: `010-1000-000${i}` })) }),
  /최대 5명/,
);
await assert.rejects(bad({ firstAttendedOn: "2026-02-30" }), /최초 등원일/);
await assert.rejects(bad({ status: "graduated" }), /상태/);
await assert.rejects(bad({ grade: "graduated" }), /학년/);
await assert.rejects(bad({ name: "" }), /이름/);

// --- 권한: 원생 관리 권한 직원은 가능, 출결 권한만 있으면 거부 ---
await signOut(auth);
await signInWithEmailAndPassword(auth, "stu6@t.dev", "pass1234");
const byStaff = await call("saveStudent", { academyId: A, name: "직원 등록", grade: "adult", status: "prospect" });
assert.equal(byStaff.attnId, `${A}_s3`);
await signOut(auth);
await signInWithEmailAndPassword(auth, "att6@t.dev", "pass1234");
await assert.rejects(
  call("saveStudent", { academyId: A, name: "x", grade: "e1", status: "enrolled" }),
  /권한/,
);
await assert.rejects(call("deleteAcademyStudent", { academyId: A, studentId: second.studentId }), /권한/);

// --- 삭제: 학생 문서·하위 기록·메모 ---
await signOut(auth);
await signInWithEmailAndPassword(auth, "owner6@t.dev", "pass1234");
await db.doc(`academies/${A}/students/${created.studentId}/sessionLogs/log-1`).set({ wasExtra: false });
await call("deleteAcademyStudent", { academyId: A, studentId: created.studentId });
assert.equal((await db.doc(`academies/${A}/students/${created.studentId}`).get()).exists, false);
assert.equal((await db.doc(`academies/${A}/studentNotes/${created.studentId}`).get()).exists, false);
assert.equal((await db.collection(`academies/${A}/students/${created.studentId}/sessionLogs`).get()).size, 0);

console.log("SMOKE OK");
process.exit(0);
