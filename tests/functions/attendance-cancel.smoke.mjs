/**
 * 2-J 출결 취소 스모크 — `npm run test:functions` (Auth·Firestore·Functions 에뮬레이터)
 * cancelClassAttendance·cancelStudentArrival: 권한(원장·출결 직원·그 반/담당 선생님 ✓, 다른 반 선생님·반 관리만 직원·무관 ✗),
 * 오늘만(date 필수), 기록 없음 changed:false, 정정 알림 문구·알림 기록 action·벨, 취소 뒤 다시 기록,
 * 반 출결 있는 날 등원 취소 거부 → 반 취소 → 등원 취소 → 반 출결 "등원 전", 차감 잠금·질병·학원 사정 거부,
 * 기타 미등원(버튼·기간 결석) 취소, 재원 아님·종강으로 바뀐 뒤에도 서버 취소(★8), sessionDeduction 거부(★4),
 * 하루 10회(반·등원), 알림 기록 응답 action, 등원 취소 뒤 키오스크 재체크인을 확인한다.
 */
import assert from "node:assert/strict";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb, Timestamp } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A = "o9_attc";

const SEOUL_WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const now = new Date();
const TODAY = now.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
const WD = SEOUL_WEEKDAY[new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(now)];
const shift = (days) =>
  new Date(Date.parse(`${TODAY}T12:00:00+09:00`) + days * 86400000).toLocaleDateString("en-CA", {
    timeZone: "Asia/Seoul",
  });
const TOMORROW = shift(1);
const YESTERDAY = shift(-1);

const mkUser = (email) => adminAuth().createUser({ email, password: "pass1234", emailVerified: true });
const owner = await mkUser("owner-attc@t.dev");
const attStaff = await mkUser("attc-staff@t.dev");
const classesOnly = await mkUser("attc-cls@t.dev");
const tA = await mkUser("attc-ta@t.dev");
const tB = await mkUser("attc-tb@t.dev");
const stranger = await mkUser("attc-stranger@t.dev");

await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "취소 학원", status: "active" });
const staff = (u, permissions) =>
  db.doc(`academies/${A}/staff/${u.uid}`).set({
    authUid: u.uid, displayName: u.email, status: "active", roleId: "x", permissions, employmentStatus: "employed",
  });
await staff(attStaff, ["lessons.attendance"]);
await staff(classesOnly, ["operations.classes"]);
await staff(tA, []);
await staff(tB, []);
await db.doc(`academies/${A}/parents/p9c`).set({ authUid: "p9c", displayName: "보호자", status: "active" });

const todaySlot = { weekday: WD, start: "15:00", end: "17:00" };
const cls = (name, extra) => ({ name, status: "active", sortOrder: 0, roomId: null, capacity: null, ...extra });
await db.doc(`academies/${A}/classes/cA`).set(cls("A반", { schedule: [todaySlot], teacherUids: [tA.uid] }));
await db.doc(`academies/${A}/classes/cB`).set(cls("B반", { schedule: [todaySlot], teacherUids: [tB.uid] }));
await db.doc(`academies/${A}/classes/cZ`).set(cls("곧끝반", { schedule: [todaySlot], teacherUids: [tA.uid] }));

const student = (id, extra) =>
  db.doc(`academies/${A}/students/${id}`).set({
    name: id.toUpperCase(), status: "enrolled", grade: "e3", gradeYear: 2026, guardians: [], guardianPhones: [],
    parentUids: ["p9c"], classIds: ["cA"], teacherUids: [tA.uid], ...extra,
  });
for (const id of ["s1", "s2", "s3", "s4", "s5", "s6", "s8", "s9", "s10"]) await student(id, {});
await student("s7", { classIds: ["cZ"] });

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);
const as = async (u) => {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, u.email, "pass1234");
};
const arrival = (sid) => ({ academyId: A, studentId: sid });
const klass = (classId, sid) => ({ academyId: A, classId, studentId: sid });
const cancelArrival = (sid, extra = {}) => call("cancelStudentArrival", { ...arrival(sid), date: TODAY, ...extra });
const cancelClass = (classId, sid, extra = {}) =>
  call("cancelClassAttendance", { ...klass(classId, sid), date: TODAY, ...extra });
const arrivalDoc = async (sid) =>
  (await db.doc(`academies/${A}/students/${sid}/attendanceRecords/${TODAY}`).get()).data();
const classDoc = async (classId, sid) =>
  (await db.doc(`academies/${A}/attendance/${TODAY}_${classId}_${sid}`).get()).data();
const notifs = async (sid) =>
  (await db.collection(`academies/${A}/attendanceNotifications`).where("studentId", "==", sid).get()).docs
    .map((d) => d.data())
    .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
const lastBell = async (sid) =>
  (await db.collection("users/p9c/dashboardBellItems").orderBy("createdAt", "asc").get()).docs
    .map((d) => d.data())
    .filter((b) => b.studentId === sid)
    .at(-1);
const T = "\\(알림 전송 시각 ([01]\\d|2[0-3]):[0-5]\\d\\)$";

// --- 준비: 그 반 선생님이 s1 등원 + A반 출석 ---
await as(tA);
await call("recordStudentArrival", { ...arrival("s1"), status: "present" });
await call("recordClassAttendance", { ...klass("cA", "s1"), status: "present" });

// --- 권한: 다른 반 선생님·반 관리만 직원·무관 ✗ ---
for (const u of [tB, classesOnly]) {
  await as(u);
  await assert.rejects(cancelClass("cA", "s1"), /이 반 출결을 취소할 권한이 없습니다/);
  await assert.rejects(cancelArrival("s1"), /담당 반 학생만 등원 기록을 취소할 수 있습니다/);
}
await as(stranger);
await assert.rejects(cancelClass("cA", "s1"), /권한/);
await assert.rejects(cancelArrival("s1"), /권한/);
assert.ok(await classDoc("cA", "s1"), "거부되면 그대로");

// --- 오늘만(★2)·입력 ---
await as(tA);
await assert.rejects(cancelClass("cA", "s1", { date: YESTERDAY }), /오늘 기록만 취소할 수 있습니다/);
await assert.rejects(cancelArrival("s1", { date: TOMORROW }), /오늘 기록만 취소할 수 있습니다/);
await assert.rejects(call("cancelStudentArrival", arrival("s1")), /요청이 올바르지 않습니다/);
await assert.rejects(cancelClass("cA", "s1", { date: "2026/11/05" }), /요청이 올바르지 않습니다/);
await assert.rejects(cancelClass("cA", "s1", { via: "kiosk" }), /경로/);
await assert.rejects(cancelArrival("s1", { via: "class_detail" }), /경로/);
await assert.rejects(cancelClass("nope", "s1"), /반을 찾을 수 없습니다/);

// --- 반 출결이 있는 날 등원 취소 거부 ---
await assert.rejects(cancelArrival("s1"), /오늘 수업 출결이 1건 있어 등원 기록을 취소할 수 없습니다\. 출석·결석 기록을 먼저 취소해 주세요\./);
assert.equal((await arrivalDoc("s1")).status, "present");

// --- 반 출석 취소(그 반 선생님) ---
const cc1 = await cancelClass("cA", "s1", { via: "teacher_my_classes" });
assert.equal(cc1.changed, true);
assert.equal(cc1.cancelled, "present");
assert.equal(await classDoc("cA", "s1"), undefined, "문서 삭제 → 미처리");
const n1 = (await notifs("s1")).at(-1);
assert.equal(n1.action, "cancel");
assert.equal(n1.kind, "present");
assert.equal(n1.context, "class");
assert.equal(n1.classId, "cA");
assert.equal(n1.className, "A반");
assert.equal(n1.date, TODAY);
assert.equal(n1.via, "teacher_my_classes");
const b1 = await lastBell("s1");
assert.match(b1.body, new RegExp(`^S1 학생의 A반 수업 출석 기록이 취소되었습니다\\. ${T}`));
assert.equal(b1.action, "cancel");
assert.equal(b1.kind, "class_present");

// 기록 없음 → changed:false, 알림 없음
const before = (await notifs("s1")).length;
const cc2 = await cancelClass("cA", "s1");
assert.equal(cc2.changed, false);
assert.equal(cc2.cancelled, null);
assert.equal(cc2.notification, null);
assert.equal((await notifs("s1")).length, before);

// 취소 뒤 다시 기록 → 결석 취소 문구
assert.equal((await call("recordClassAttendance", { ...klass("cA", "s1"), status: "absent" })).changed, true);
assert.equal((await cancelClass("cA", "s1")).cancelled, "absent");
assert.match((await lastBell("s1")).body, new RegExp(`^S1 학생의 A반 수업 결석 기록이 취소되었습니다\\. ${T}`));

// --- 등원 취소(담당 선생님) → 반 출결은 "등원 전" ---
const ca1 = await cancelArrival("s1", { via: "teacher_my_classes" });
assert.equal(ca1.changed, true);
assert.equal(ca1.cancelled, "present");
assert.equal(await arrivalDoc("s1"), undefined, "기록 없음으로");
const n2 = (await notifs("s1")).at(-1);
assert.equal(n2.action, "cancel");
assert.equal(n2.context, "arrival");
assert.equal(n2.kind, "present");
const b2 = await lastBell("s1");
assert.match(b2.body, new RegExp(`^S1 학생의 등원 기록이 취소되었습니다\\. ${T}`));
assert.equal(b2.kind, "attendance_present");
assert.equal(b2.action, "cancel");
await assert.rejects(
  call("recordClassAttendance", { ...klass("cA", "s1"), status: "present" }),
  /아직 등원 처리되지 않았습니다/,
);
assert.equal((await cancelArrival("s1")).changed, false, "다시 취소 = 기록 없음");

// --- 기타 미등원(버튼) 취소 ---
await call("recordStudentArrival", { ...arrival("s2"), status: "absent" });
const ca2 = await cancelArrival("s2");
assert.equal(ca2.cancelled, "absent");
assert.equal(await arrivalDoc("s2"), undefined);
assert.match((await lastBell("s2")).body, new RegExp(`^S2 학생의 미등원 기록이 취소되었습니다\\. ${T}`));

// --- 기간 결석: 질병·학원 사정은 거부, 기타는 취소 ---
await as(owner);
await call("recordStudentAbsences", { ...arrival("s3"), dates: [TODAY], reason: "illness" });
await call("recordStudentAbsences", { ...arrival("s4"), dates: [TODAY], reason: "academy" });
await call("recordStudentAbsences", { ...arrival("s9"), dates: [TODAY], reason: "general", note: "가족 행사" });
await as(tA);
await assert.rejects(cancelArrival("s3"), /질병·학원 사정 미등원은 여기서 취소할 수 없습니다/);
await assert.rejects(cancelArrival("s4"), /질병·학원 사정 미등원은 여기서 취소할 수 없습니다/);
assert.equal((await arrivalDoc("s3")).reason, "illness", "거부되면 그대로");
assert.equal((await cancelArrival("s9")).cancelled, "absent");
assert.equal(await arrivalDoc("s9"), undefined);

// --- 차감 잠금 거부 ---
await db.doc(`academies/${A}/students/s5/attendanceRecords/${TODAY}`).set({
  date: TODAY, status: "absent", reason: "general", billedInvoicePeriod: TODAY.slice(0, 7), billedAdjustmentId: "adj1",
});
await assert.rejects(cancelArrival("s5"), /결석 차감에 반영되어 있어 변경할 수 없습니다/);
assert.ok(await arrivalDoc("s5"));

// --- 출결 권한 직원: 모든 반·학생 ---
await as(attStaff);
await call("recordStudentArrival", { ...arrival("s6"), status: "present" });
await call("recordClassAttendance", { ...klass("cA", "s6"), status: "present" });
assert.equal((await cancelClass("cA", "s6")).changed, true);
assert.equal((await cancelArrival("s6")).changed, true);
assert.equal((await notifs("s6")).at(-1).senderRole, "teacher");

// --- 원장: 재원 아님·종강으로 바뀐 뒤에도 취소(★8 서버) ---
await as(owner);
await call("recordStudentArrival", { ...arrival("s7"), status: "present" });
await call("recordClassAttendance", { ...klass("cZ", "s7"), status: "present" });
await db.doc(`academies/${A}/students/s7`).update({ status: "on_leave" });
await db.doc(`academies/${A}/classes/cZ`).update({ status: "ended" });
const cc7 = await cancelClass("cZ", "s7");
assert.equal(cc7.changed, true);
assert.match((await lastBell("s7")).body, /^S7 학생의 곧끝반 수업 출석 기록이 취소되었습니다\./);
assert.equal((await notifs("s7")).at(-1).senderRole, "owner");
assert.equal((await cancelArrival("s7")).changed, true);

// --- sessionDeduction이 있으면 거부(★4) ---
await call("recordStudentArrival", { ...arrival("s8"), status: "present" });
await call("recordClassAttendance", { ...klass("cA", "s8"), status: "present" });
await db.doc(`academies/${A}/attendance/${TODAY}_cA_s8`).update({ sessionDeduction: { ledgerId: "l1", at: Timestamp.now() } });
await assert.rejects(cancelClass("cA", "s8"), /회차 차감이 연결된 기록이라 취소할 수 없습니다/);
assert.ok(await classDoc("cA", "s8"));

// --- 하루 10회: 반 키 ---
await call("recordStudentArrival", { ...arrival("s10"), status: "present" }); // 등원 키 1회
let st = "absent";
for (let i = 0; i < 10; i++) {
  st = st === "absent" ? "present" : "absent";
  const r = await call("recordClassAttendance", { ...klass("cA", "s10"), status: st });
  assert.notEqual(r.notification.reason, "daily_limit", `반 ${i + 1}번째는 보냄`);
}
const ccLimit = await cancelClass("cA", "s10");
assert.equal(ccLimit.changed, true);
assert.equal(ccLimit.notification.reason, "daily_limit");
assert.equal(await classDoc("cA", "s10"), undefined, "제한이어도 기록은 취소");
// 등원 키: 지금 1회 → 9회 더 바꾸면 10회, 그 뒤 취소는 daily_limit
st = "present";
for (let i = 0; i < 9; i++) {
  st = st === "absent" ? "present" : "absent";
  const r = await call("recordStudentArrival", { ...arrival("s10"), status: st });
  assert.notEqual(r.notification.reason, "daily_limit", `등원 ${i + 2}번째는 보냄`);
}
const caLimit = await cancelArrival("s10");
assert.equal(caLimit.changed, true);
assert.equal(caLimit.notification.reason, "daily_limit");
assert.equal(await arrivalDoc("s10"), undefined);

// --- 알림 기록 응답 action ---
const log = await call("listAttendanceNotifications", { academyId: A, limit: 100 });
assert.ok(log.items.some((x) => x.action === "cancel" && x.context === "class" && x.className === "A반"));
assert.ok(log.items.some((x) => x.action === "cancel" && x.context === "arrival"));
assert.ok(log.items.some((x) => x.action === "record"));

// --- 등원 취소 뒤 키오스크 재체크인 = 새 등원 + 알림 ---
const k1 = await call("submitKioskCheckIn", arrival("s1"));
assert.equal(k1.alreadyArrived, false);
assert.equal((await arrivalDoc("s1")).status, "present");
assert.match((await lastBell("s1")).body, /^S1 학생이 안전하게 등원하였습니다\./);

await signOut(auth);
console.log("SMOKE OK attendance-cancel");
process.exit(0);
