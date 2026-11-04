/**
 * 반 Callable·트리거 통합 스모크 — `npm run test:functions` (Auth·Firestore·Functions 에뮬레이터)
 * saveClass 검증·권한, 원생 배정 → classIds·teacherUids, 정원 초과 표시, add·remove 중복 거부,
 * 선생님 변경 트리거(학생 트리거 3개는 parentUids·잔여 그대로라 바로 끝남), 종강 → 제외·추가 거부·해제 허용, 재개 → 복구,
 * 삭제된 강의실(바뀌지 않으면 통과, 새로 고르면 거부), 순서, 이력, 담당 학생·내 반 클라이언트 쿼리·출결 알림(teacherUids),
 * 수정은 보낸 필드만(빠진 필드 유지·강의실/정원 null = 비움·teacherUids [] = 모두 제거·종강 반 status 생략 = 종강 유지),
 * 배정 해제와 선생님 변경이 겹쳐도 빠진 학생에 예전 선생님이 남지 않음, 직원 계정 삭제 → 반·학생에서 빠짐,
 * 반 삭제 → classIds 정리를 확인한다.
 */
import assert from "node:assert/strict";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb, Timestamp } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut } from "firebase/auth";
import {
  collection,
  connectFirestoreEmulator,
  getDocs,
  getFirestore,
  query,
  where,
} from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A = "o8_a1";

const mkUser = (email) => adminAuth().createUser({ email, password: "pass1234", emailVerified: true });
const owner = await mkUser("owner8@t.dev");
const classesStaff = await mkUser("cls8@t.dev");
const studentsStaff = await mkUser("stu8@t.dev");
const t1 = await mkUser("t1e8@t.dev");
const t2 = await mkUser("t2e8@t.dev");
const t3 = await mkUser("t3e8@t.dev");
await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "반 학원", status: "active" });
await db.doc(`academies/${A}/meta/seq`).set({ nextTeacherSeq: 1, nextParentSeq: 1, nextStudentSeq: 1 });
await db.doc(`academies/${A}/meta/options`).set({
  guardianRelations: [{ id: "mother", label: "어머니" }],
  rooms: [{ id: "room1", label: "1강의실" }, { id: "room2", label: "2강의실" }],
});
const staff = (u, name, permissions) => db.doc(`academies/${A}/staff/${u.uid}`).set({
  authUid: u.uid, displayName: name, status: "active", roleId: "x", permissions, employmentStatus: "employed",
});
await staff(classesStaff, "반 담당", ["operations.classes"]);
await staff(studentsStaff, "원생 담당", ["operations.students"]);
await staff(t1, "선생1", []);
await staff(t2, "선생2", []);
await staff(t3, "선생3", []);
await db.doc(`academies/${A}/staff/hr-only`).set({
  authUid: null, displayName: "계정 없음", status: "no_account", roleId: "x", permissions: [],
});

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const clientDb = getFirestore(app);
connectFirestoreEmulator(clientDb, "127.0.0.1", 8080);
/** 선생님 화면과 같은 클라이언트 쿼리(보안 규칙을 거침) */
const myTaughtStudents = async (uid) =>
  (await getDocs(query(collection(clientDb, `academies/${A}/students`), where("teacherUids", "array-contains", uid))))
    .docs.map((d) => ({ id: d.id, ...d.data() }));
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);
const studentDoc = async (id) => (await db.doc(`academies/${A}/students/${id}`).get()).data();
const classDoc = async (id) => (await db.doc(`academies/${A}/classes/${id}`).get());
const sorted = (xs) => [...(xs ?? [])].sort();
const sameSet = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const history = async (classId) =>
  (await db.collection(`academies/${A}/classHistory`).where("classId", "==", classId).get()).docs.map((d) => d.data());

async function waitFor(label, check, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new Error(`시간 초과: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
const waitTeachers = (label, studentId, expected) =>
  waitFor(label, async () => sameSet((await studentDoc(studentId)).teacherUids, expected));

async function signInAs(email) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, email, "pass1234");
}

// --- 원생 준비 ---
await signInAs("owner8@t.dev");
const mkStudent = async (name) => (await call("saveStudent", { academyId: A, name, grade: "e3", status: "enrolled" })).studentId;
const s1 = await mkStudent("일번");
const s2 = await mkStudent("이번");
const s3 = await mkStudent("삼번");
const s4 = await mkStudent("사번");
const s5 = await mkStudent("오번");
const s6 = await mkStudent("육번");

// --- 권한: 반 관리 권한만 저장·배정, 원생 권한·권한 없는 선생님은 거부 ---
await signInAs("stu8@t.dev");
await assert.rejects(call("saveClass", { academyId: A, name: "x" }), /권한/);
await signInAs("t1e8@t.dev");
await assert.rejects(call("saveClass", { academyId: A, name: "x" }), /권한/);

// --- 검증 ---
await signInAs("cls8@t.dev");
const bad = (patch) => call("saveClass", { academyId: A, name: "검증", status: "active", ...patch });
await assert.rejects(bad({ name: "" }), /반 이름/);
await assert.rejects(bad({ status: "closed" }), /반 상태/);
await assert.rejects(bad({ schedule: [{ weekday: 8, start: "10:00", end: "11:00" }] }), /수업 시간/);
await assert.rejects(bad({ schedule: [{ weekday: 1, start: "11:00", end: "10:00" }] }), /시작 시간보다 늦어야/);
await assert.rejects(
  bad({ schedule: [{ weekday: 1, start: "10:00", end: "11:00" }, { weekday: 1, start: "10:00", end: "11:00" }] }),
  /두 번/,
);
await assert.rejects(bad({ capacity: 0 }), /정원/);
await assert.rejects(bad({ teacherUids: Array.from({ length: 11 }, (_, i) => `u${i}`) }), /최대 10명/);
await assert.rejects(bad({ teacherUids: ["hr-only"] }), /계정이 있는 직원/, "계정 없는 직원(D6)");
await assert.rejects(bad({ teacherUids: ["nobody"] }), /계정이 있는 직원/);
await assert.rejects(bad({ roomId: "room-gone" }), /강의실이 삭제/);

// --- 생성: 이력·순서 ---
const created = await call("saveClass", {
  academyId: A, name: "A반", status: "active", teacherUids: [t1.uid], roomId: "room1", capacity: 2,
  schedule: [{ weekday: 3, start: "16:00", end: "17:00" }, { weekday: 1, start: "16:00", end: "17:00" }],
});
const cA = created.classId;
let classA = await classDoc(cA);
assert.equal(classA.get("sortOrder"), 0);
assert.deepEqual(classA.get("schedule").map((x) => x.weekday), [1, 3], "요일 순 정렬");
assert.equal(classA.get("endedAt"), null);
const cB = (await call("saveClass", { academyId: A, name: "B반", teacherUids: [t2.uid, owner.uid] })).classId;
assert.equal((await classDoc(cB)).get("sortOrder"), 1);
assert.equal((await classDoc(cB)).get("status"), "active", "상태 기본값 운영중");
assert.deepEqual((await history(cA)).map((h) => h.type), ["created"]);
// 같은 값으로 다시 저장하면 이력·쓰기 없음
const same = await call("saveClass", {
  academyId: A, classId: cA, name: "A반", status: "active", teacherUids: [t1.uid], roomId: "room1", capacity: 2,
  schedule: [{ weekday: 1, start: "16:00", end: "17:00" }, { weekday: 3, start: "16:00", end: "17:00" }],
});
assert.equal(same.changed, false);

// --- 원생 배정: classIds·teacherUids, 정원 초과 표시, 이력 ---
await assert.rejects(
  call("setClassStudents", { academyId: A, classId: cA, add: [s1], remove: [s1] }),
  /추가와 해제에 함께/,
);
await assert.rejects(call("setClassStudents", { academyId: A, classId: cA, add: [], remove: [] }), /선택해/);
const assigned = await call("setClassStudents", { academyId: A, classId: cA, add: [s1, s2, s3, "no-such"] });
assert.deepEqual(sorted(assigned.added), sorted([s1, s2, s3]));
assert.equal(assigned.failures.length, 1);
assert.equal(assigned.studentCount, 3);
assert.equal(assigned.overCapacity, true, "정원 2명 < 3명 — 막지 않고 표시");
assert.deepEqual((await studentDoc(s1)).classIds, [cA]);
assert.deepEqual((await studentDoc(s1)).teacherUids, [t1.uid]);
const again = await call("setClassStudents", { academyId: A, classId: cA, add: [s1] });
assert.deepEqual(again.unchanged, [s1]);
await call("setClassStudents", { academyId: A, classId: cB, add: [s1] });
assert.deepEqual((await studentDoc(s1)).teacherUids, sorted([t1.uid, t2.uid, owner.uid]), "여러 반 = 선생님 합집합");
const addedHistory = (await history(cA)).find((h) => h.type === "students_added");
assert.deepEqual(sorted(addedHistory.studentIds), sorted([s1, s2, s3]));
assert.equal(addedHistory.actorUid, classesStaff.uid);

// --- 담당 학생 목록(클라이언트 쿼리·규칙)·출결 알림(권한 없는 선생님 = teacherUids) ---
await signInAs("t1e8@t.dev");
const taught = await myTaughtStudents(t1.uid);
assert.deepEqual(sorted(taught.map((s) => s.id)), sorted([s1, s2, s3]));
assert.deepEqual(taught.find((s) => s.id === s1).classIds, [cA, cB]);
const myClasses = await getDocs(
  query(collection(clientDb, `academies/${A}/classes`), where("teacherUids", "array-contains", t1.uid)),
);
assert.deepEqual(myClasses.docs.map((d) => d.id), [cA], "내 반 쿼리");
const notify = await call("sendStudentAttendanceNotification", { academyId: A, studentId: s2, kind: "present" });
assert.equal(notify.reason, "no_parent", "담당 반 학생은 보낼 수 있음(보호자 없음)");
await assert.rejects(
  call("sendStudentAttendanceNotification", { academyId: A, studentId: s4, kind: "present" }),
  /담당 반 학생만/,
);

// --- 선생님 변경 → 트리거가 학생 teacherUids를 맞춘다. 학생 트리거 3개는 바로 끝남(연결·결제·잔여 그대로) ---
await db.doc(`academies/${A}/parents/p-linked`).set({
  authUid: "p-linked", status: "active", linkedStudentIds: [s2], updatedAt: Timestamp.fromMillis(1000),
});
await db.doc(`academies/${A}/students/${s2}`).update({
  guardians: [{ id: "g_linked1", relationId: null, name: null, phone: "010-1212-3434", isPrimary: true, linkedParentUid: "p-linked" }],
  guardianPhones: ["01012123434"], parentUids: ["p-linked"], weeklySessionCount: 1, sessionBalance: 3,
});
await db.doc(`academies/${A}/payments/pay-s2`).set({ studentId: s2, parentUids: ["p-linked"], amount: 1000, status: "PAID", createdAt: Timestamp.now() });
await new Promise((r) => setTimeout(r, 1500)); // 위 쓰기로 도는 학생 트리거가 끝나기를 기다림
const parentUpdatedAt = (await db.doc(`academies/${A}/parents/p-linked`).get()).get("updatedAt").toMillis();
assert.equal(parentUpdatedAt, 1000, "요약이 같으면 학부모 문서를 쓰지 않음");
console.log("[classes.smoke] 반 선생님 변경 시작 — 이후 학생 트리거 로그가 바로 끝나야 함");
await signInAs("cls8@t.dev");
await call("saveClass", { academyId: A, classId: cA, name: "A반", teacherUids: [t1.uid, t3.uid], roomId: "room1", capacity: 2,
  schedule: [{ weekday: 1, start: "16:00", end: "17:00" }, { weekday: 3, start: "16:00", end: "17:00" }] });
await waitTeachers("선생님 추가 → 학생 반영", s2, [t1.uid, t3.uid]);
await waitTeachers("여러 반 학생", s1, [t1.uid, t2.uid, t3.uid, owner.uid]);
await new Promise((r) => setTimeout(r, 1500));
assert.equal((await db.doc(`academies/${A}/parents/p-linked`).get()).get("updatedAt").toMillis(), 1000, "학부모 요약 트리거가 쓰지 않음");
assert.deepEqual((await db.doc(`academies/${A}/payments/pay-s2`).get()).get("parentUids"), ["p-linked"]);
assert.equal((await studentDoc(s2)).sessionBalance, 3);
console.log("[classes.smoke] 반 선생님 변경 끝");
const updatedHistory = (await history(cA)).find((h) => h.type === "updated");
assert.deepEqual(updatedHistory.changes.teacherUids, { before: [t1.uid], after: sorted([t1.uid, t3.uid]) });

// --- 종강: 학생 teacherUids에서 빠짐(classIds는 유지), 추가 거부, 해제 허용 / 재개: 복구 ---
const aBase = { academyId: A, classId: cA, name: "A반", teacherUids: [t1.uid, t3.uid], roomId: "room1", capacity: 2,
  schedule: [{ weekday: 1, start: "16:00", end: "17:00" }, { weekday: 3, start: "16:00", end: "17:00" }] };
await call("saveClass", { ...aBase, status: "ended" });
await waitTeachers("종강 → 제외", s2, []);
await waitTeachers("종강 → 다른 반 선생님만", s1, [t2.uid, owner.uid]);
assert.deepEqual((await studentDoc(s2)).classIds, [cA], "종강해도 classIds 유지");
assert.ok((await classDoc(cA)).get("endedAt"), "종강 시각");
await assert.rejects(call("setClassStudents", { academyId: A, classId: cA, add: [s4] }), /종강한 반에는 원생을 추가할 수 없습니다/);
const removedFromEnded = await call("setClassStudents", { academyId: A, classId: cA, remove: [s3] });
assert.deepEqual(removedFromEnded.removed, [s3], "종강 반 해제는 허용");
assert.deepEqual((await studentDoc(s3)).classIds, []);
await call("saveClass", { ...aBase, status: "active" });
await waitTeachers("재개 → 복구", s2, [t1.uid, t3.uid]);
assert.equal((await classDoc(cA)).get("endedAt"), null);
assert.deepEqual(
  (await history(cA)).map((h) => h.type).filter((t) => t === "ended" || t === "reopened").sort(),
  ["ended", "reopened"],
);
// 준비중 반에는 추가 허용
const cP = (await call("saveClass", { academyId: A, name: "준비반", status: "preparing", teacherUids: [t2.uid] })).classId;
assert.deepEqual((await call("setClassStudents", { academyId: A, classId: cP, add: [s4] })).added, [s4]);
assert.deepEqual((await studentDoc(s4)).teacherUids, [t2.uid], "준비중 반 선생님은 포함");

// --- 삭제된 강의실: 바뀌지 않으면 통과, 새로 고르면 거부 ---
await db.doc(`academies/${A}/meta/options`).update({ rooms: [{ id: "room2", label: "2강의실" }] });
const renamed = await call("saveClass", { ...aBase, name: "A반(수정)", status: "active" });
assert.equal(renamed.changed, true, "삭제된 강의실이 그대로면 다른 필드 수정 가능");
assert.equal((await classDoc(cA)).get("roomId"), "room1");
await assert.rejects(
  call("saveClass", { academyId: A, classId: cB, name: "B반", teacherUids: [t2.uid, owner.uid], roomId: "room1" }),
  /강의실이 삭제/,
);
await call("saveClass", { academyId: A, classId: cB, name: "B반", teacherUids: [t2.uid, owner.uid], roomId: "room2" });

// --- 순서 ---
await assert.rejects(call("reorderClasses", { academyId: A, orderedIds: [cB, cA] }), /반 목록이 바뀌었습니다/);
await call("reorderClasses", { academyId: A, orderedIds: [cP, cB, cA] });
assert.deepEqual(
  [(await classDoc(cP)).get("sortOrder"), (await classDoc(cB)).get("sortOrder"), (await classDoc(cA)).get("sortOrder")],
  [0, 1, 2],
);

// --- 수정은 보낸 필드만: 빠진 필드는 기존 값 유지, 강의실·정원 null = 비움 ---
const pBase = {
  status: "active", teacherUids: [t2.uid], roomId: "room2", capacity: 5,
  schedule: [{ weekday: 2, start: "15:00", end: "16:00" }, { weekday: 4, start: "15:00", end: "16:00" }],
};
const cN = (await call("saveClass", { academyId: A, name: "부분수정반", ...pBase })).classId;
await call("setClassStudents", { academyId: A, classId: cN, add: [s3] });
assert.deepEqual((await studentDoc(s3)).teacherUids, [t2.uid]);
const fieldsOf = async (id) => {
  const d = (await classDoc(id)).data();
  return { status: d.status, teacherUids: d.teacherUids, roomId: d.roomId, capacity: d.capacity, schedule: d.schedule };
};
const nameOnly = await call("saveClass", { academyId: A, classId: cN, name: "부분수정반2" });
assert.equal(nameOnly.changed, true);
assert.equal((await classDoc(cN)).get("name"), "부분수정반2");
assert.deepEqual(await fieldsOf(cN), pBase, "이름만 보낸 수정 → 나머지 그대로");
const nameHistory = (await history(cN)).find((h) => h.type === "updated");
assert.deepEqual(Object.keys(nameHistory.changes), ["name"], "바뀐 필드만 이력에");
await new Promise((r) => setTimeout(r, 1500)); // 트리거가 돌았다면 끝나기를 기다림
assert.deepEqual((await studentDoc(s3)).teacherUids, [t2.uid], "이름만 수정 → 학생 teacherUids 그대로");
// null도 이름·상태·시간·선생님은 유지
assert.equal((await call("saveClass", { academyId: A, classId: cN, status: null, teacherUids: null, schedule: null })).changed, false);
await call("saveClass", { academyId: A, classId: cN, roomId: null, capacity: null });
assert.deepEqual(await fieldsOf(cN), { ...pBase, roomId: null, capacity: null }, "강의실·정원 null → 비움");
// teacherUids: []를 직접 보내면 지금처럼 모두 빠짐 → 학생 teacherUids도 빔
await call("saveClass", { academyId: A, classId: cN, teacherUids: [] });
assert.deepEqual((await classDoc(cN)).get("teacherUids"), []);
await waitTeachers("teacherUids [] → 학생에서 빠짐", s3, []);
await call("saveClass", { academyId: A, classId: cN, teacherUids: [t2.uid] });
await waitTeachers("선생님 다시 지정", s3, [t2.uid]);
// 종강 반에 status 없이 수정 → 종강 유지(학생 teacherUids도 빈 채로)
await call("saveClass", { academyId: A, classId: cN, status: "ended" });
await waitTeachers("종강 → 제외", s3, []);
const endedAt = (await classDoc(cN)).get("endedAt").toMillis();
await call("saveClass", { academyId: A, classId: cN, name: "부분수정반3", capacity: 3 });
assert.equal((await classDoc(cN)).get("status"), "ended", "status 생략 → 종강 유지");
assert.equal((await classDoc(cN)).get("endedAt").toMillis(), endedAt, "종강 시각 그대로");
await new Promise((r) => setTimeout(r, 1500));
assert.deepEqual((await studentDoc(s3)).teacherUids, [], "종강 유지 → 학생 teacherUids 빈 채로");

// --- 배정 해제와 선생님 변경이 겹쳐도 빠진 학생에 예전·새 선생님이 남지 않는다 ---
const cR = (await call("saveClass", { academyId: A, name: "경합반", teacherUids: [t3.uid] })).classId;
let raceTeachers = [t3.uid];
for (let i = 0; i < 4; i++) {
  await call("setClassStudents", { academyId: A, classId: cR, add: [s5, s6] });
  await waitTeachers(`경합 ${i} 준비`, s5, raceTeachers);
  raceTeachers = i % 2 === 0 ? [t1.uid] : [t3.uid];
  await Promise.all([
    call("setClassStudents", { academyId: A, classId: cR, remove: [s5] }),
    call("saveClass", { academyId: A, classId: cR, name: "경합반", teacherUids: raceTeachers }),
  ]);
  await waitTeachers(`경합 ${i} 남은 학생`, s6, raceTeachers);
  await new Promise((r) => setTimeout(r, 800));
  const st5 = await studentDoc(s5);
  assert.deepEqual(st5.classIds, [], `경합 ${i}: 빠진 학생 classIds`);
  assert.deepEqual(st5.teacherUids, [], `경합 ${i}: 빠진 학생에 선생님이 남지 않음`);
}

// --- 직원 계정 삭제 → 반 teacherUids에서 바로, 학생 teacherUids에서는 트리거로 빠짐 ---
await signInAs("owner8@t.dev");
await call("deleteTeacherInvite", { academyId: A, teacherId: t3.uid });
assert.ok(!(await classDoc(cA)).get("teacherUids").includes(t3.uid), "반에서 빠짐");
assert.equal((await db.doc(`academies/${A}/staff/${t3.uid}`).get()).exists, false, "계정 문서 분리");
await waitTeachers("직원 삭제 → 학생에서 빠짐", s2, [t1.uid]);
const stripHistory = (await history(cA)).find((h) => h.type === "updated" && h.actorUid === owner.uid);
assert.deepEqual(stripHistory.changes.teacherUids, { before: sorted([t1.uid, t3.uid]), after: [t1.uid] });
// 지운 계정은 새로 고를 수 없다(D6)
await assert.rejects(call("saveClass", { ...aBase, name: "A반", teacherUids: [t1.uid, t3.uid] }), /계정이 있는 직원/);

// --- 반 삭제 → 학생 classIds·teacherUids 정리, 이력 ---
await signInAs("t1e8@t.dev");
await assert.rejects(call("deleteClass", { academyId: A, classId: cB }), /권한/);
await signInAs("cls8@t.dev");
const del = await call("deleteClass", { academyId: A, classId: cB });
assert.equal(del.removedStudentCount, 1);
assert.equal((await classDoc(cB)).exists, false);
assert.deepEqual((await studentDoc(s1)).classIds, [cA]);
assert.deepEqual((await studentDoc(s1)).teacherUids, [t1.uid]);
const deletedHistory = (await history(cB)).find((h) => h.type === "deleted");
assert.deepEqual(deletedHistory.studentIds, [s1]);
assert.equal(deletedHistory.className, "B반");
// 반 문서를 직접 지워도(삭제와 동시 배정의 찌꺼기) 트리거가 classIds를 정리
await db.doc(`academies/${A}/classes/${cP}`).delete();
await waitFor("삭제된 반 → 트리거가 classIds 정리", async () => (await studentDoc(s4)).classIds.length === 0);
assert.deepEqual((await studentDoc(s4)).teacherUids, []);

console.log("SMOKE OK");
process.exit(0);
