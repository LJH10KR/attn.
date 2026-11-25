/**
 * 3-B 지각·하원·휴강·출결 설정·알림 다시 보내기·학부모 출결 기록 스모크 — `npm run test:functions`
 * 결정 `docs/stage3-handoff/3-B-decisions.md`, 계획 `3-B-plan.md`.
 * - 지각: 권한 4종, 분 범위, 분만 바꾸면 알림 0 + 정정 이력(★2), 상태 바뀌면 알림, 지각 취소, 지난 날짜 정정, 일괄 지각 줄 건너뜀(★3)
 * - 하원: 오늘·취소·H2·H3·하원 있으면 미등원·등원 취소·지난 날짜 미등원/지우기·기록 삭제·기간 결석 거부(★5), 잠금 날 허용,
 *   하원 하루 10회가 등원과 따로(B5), 지난 날짜 정정·시각 검사(★6), 오늘 시각만(★7), 일괄 하원(오늘 알림·지난 무알림),
 *   미등원 경로에 하원 필드가 남지 않음, 키오스크 모드 공용 로직(`recordDepartureCore`, B10)
 * - 휴강: 권한, 오늘 조건·기록 있으면 거부, 지난 날짜 P1(지금 종강한 반), 휴강 반 출결 거부(오늘·정정·일괄), 메모·취소·삭제된 반, 이력, 알림 0,
 *   반 관리 목록 경로 `class_list`(3-B 후속 Q2)
 * - 출결 설정: 권한·형식, 끈 종류 = 알림 기록 muted만(벨 0·하루 10회 안 셈, ★9),
 *   취소 알림 = 원래 종류 그리고 정정(3-B 후속 F2 — 하원 끔·정정 끔·둘 다 켬·지각 끔, 다시 보내기도 같은 판단)
 * - 다시 보내기: 권한, 오늘·상태 같음만, 꺼짐 거부, 하루 10회, "(다시 알림)"
 * - 학부모 출결 기록: 연결된 자녀만, 다른·비활성 학부모·직원 거부, 메모·코멘트 없음, 31일, 휴강만 있는 날(P2)
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb, Timestamp } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A = "o9_att3b";

const SEOUL_WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
const shift = (days) =>
  new Date(Date.parse(`${TODAY}T12:00:00+09:00`) + days * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
const weekdayOf = (date) =>
  SEOUL_WEEKDAY[
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(new Date(`${date}T12:00:00+09:00`))
  ];
const Y1 = shift(-1);
const Y2 = shift(-2);
const OLD40 = shift(-40);
const TOMORROW = shift(1);
const WD_TODAY = weekdayOf(TODAY);
const seoulMs = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+09:00`);
// 지금(서울 HH:mm) — 오늘 시각 고치기는 지금 이후를 거부(R1)
const NOW_HM = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const mkUser = (email, uid) => adminAuth().createUser({ ...(uid ? { uid } : {}), email, password: "pass1234", emailVerified: true });
const owner = await mkUser("owner-3b@t.dev");
const attStaff = await mkUser("att-3b@t.dev");
const classesOnly = await mkUser("cls-3b@t.dev");
const tA = await mkUser("ta-3b@t.dev");
const tB = await mkUser("tb-3b@t.dev");
const parent = await mkUser("p-3b@t.dev", "p3b");
const otherParent = await mkUser("p2-3b@t.dev", "p3c");
const inactiveParent = await mkUser("p3-3b@t.dev", "p3d");

await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "3B 학원", status: "active" });
const staff = (u, permissions, name) =>
  db.doc(`academies/${A}/staff/${u.uid}`).set({
    authUid: u.uid, displayName: name, status: "active", roleId: "x", permissions, employmentStatus: "employed",
  });
await staff(attStaff, ["lessons.attendance", "lessons.notificationLog"], "출결 직원");
await staff(classesOnly, ["operations.classes"], "반 직원");
await staff(tA, [], "A선생");
await staff(tB, [], "B선생");
await db.doc(`academies/${A}/parents/p3b`).set({ authUid: "p3b", displayName: "보호자", status: "active" });
await db.doc(`academies/${A}/parents/p3c`).set({ authUid: "p3c", displayName: "다른 보호자", status: "active" });
await db.doc(`academies/${A}/parents/p3d`).set({ authUid: "p3d", displayName: "비활성 보호자", status: "inactive" });

const today = [{ weekday: WD_TODAY, start: "15:00", end: "17:00" }];
const cls = (name, extra) => ({ name, status: "active", sortOrder: 0, roomId: null, capacity: null, ...extra });
await db.doc(`academies/${A}/classes/cA`).set(cls("A반", { schedule: today, teacherUids: [tA.uid] }));
await db.doc(`academies/${A}/classes/cC`).set(cls("C반", { schedule: today, teacherUids: [tA.uid] }));
await db.doc(`academies/${A}/classes/cB`).set(cls("B반", { schedule: [], teacherUids: [tB.uid] }));
await db.doc(`academies/${A}/classes/cEnd`).set(cls("끝난반", { status: "ended", schedule: [], teacherUids: [] }));
await db.doc(`academies/${A}/classes/cDel`).set(cls("지울반", { schedule: today, teacherUids: [] }));

const student = (id, extra = {}) =>
  db.doc(`academies/${A}/students/${id}`).set({
    name: id.toUpperCase(), status: "enrolled", grade: "e3", gradeYear: 2026, guardians: [], guardianPhones: [],
    parentUids: ["p3b"], classIds: ["cA"], teacherUids: [tA.uid], ...extra,
  });
for (let i = 1; i <= 16; i++) await student(`s${i}`);
await student("c1", { classIds: ["cC"] });
await student("c2", { classIds: ["cC"] });
await student("h1", { classIds: ["cA", "cEnd"] });
await student("hx", { status: "withdrawn" });

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
const arrive = (sid, status = "present") => call("recordStudentArrival", { academyId: A, studentId: sid, status, date: TODAY });
const mark = (classId, sid, status, extra = {}) =>
  call("recordClassAttendance", { academyId: A, classId, studentId: sid, status, date: TODAY, ...extra });
const cancelClass = (classId, sid) => call("cancelClassAttendance", { academyId: A, classId, studentId: sid, date: TODAY });
const depart = (sid, extra = {}) => call("recordStudentDeparture", { academyId: A, studentId: sid, date: TODAY, ...extra });
const cancelDepart = (sid) => call("cancelStudentDeparture", { academyId: A, studentId: sid, date: TODAY });
const fixDepart = (sid, date, departed, extra = {}) =>
  call("correctStudentDeparture", { academyId: A, studentId: sid, date, departed, ...extra });
const fixArrival = (sid, date, status, extra = {}) =>
  call("correctStudentArrival", { academyId: A, studentId: sid, date, status, ...extra });
const fixClass = (classId, sid, date, status, extra = {}) =>
  call("correctClassAttendance", { academyId: A, classId, studentId: sid, date, status, ...extra });
const cancelLesson = (classId, date, cancelled, extra = {}) =>
  call("setClassCancellation", { academyId: A, classId, date, cancelled, ...extra });
const batch = (data) => call("recordAttendanceBatch", { academyId: A, classId: "cA", ...data });
const settings = (notify) => call("updateAttendanceSettings", { academyId: A, notify });
const resend = (notificationId) => call("resendAttendanceNotification", { academyId: A, notificationId });
const history = (studentId) => call("getStudentAttendanceHistory", { academyId: A, studentId });

const arrivalRef = (sid, date) => db.doc(`academies/${A}/students/${sid}/attendanceRecords/${date}`);
const arrivalDoc = async (sid, date = TODAY) => (await arrivalRef(sid, date).get()).data();
const classDoc = async (classId, sid, date = TODAY) => (await db.doc(`academies/${A}/attendance/${date}_${classId}_${sid}`).get()).data();
const notifs = async (filter = {}) => {
  let q = db.collection(`academies/${A}/attendanceNotifications`);
  for (const [k, v] of Object.entries(filter)) q = q.where(k, "==", v);
  return (await q.get()).docs.map((d) => ({ id: d.id, ...d.data() }));
};
const notifCount = async (filter) => (await notifs(filter)).length;
const bellCount = async () => (await db.collection("users/p3b/dashboardBellItems").get()).size;
const corrections = async (filter) => {
  let q = db.collection(`academies/${A}/attendanceCorrections`);
  for (const [k, v] of Object.entries(filter)) q = q.where(k, "==", v);
  return (await q.get()).docs.map((d) => d.data()).sort((a, b) => a.at.toMillis() - b.at.toMillis());
};
const ALL_ON = { arrival: true, arrivalAbsent: true, departure: true, classPresent: true, classLate: true, classAbsent: true, correction: true };

// ───────────────────── 지각 ─────────────────────
await as(owner);
await arrive("s1");
await assert.rejects(mark("cA", "s1", "late"), /지각 시간은 1~180분으로 입력해 주세요/);
await assert.rejects(mark("cA", "s1", "late", { lateMinutes: 0 }), /지각 시간은 1~180분/);
await assert.rejects(mark("cA", "s1", "late", { lateMinutes: 181 }), /지각 시간은 1~180분/);
await assert.rejects(mark("cA", "s1", "late", { lateMinutes: 12.5 }), /지각 시간은 1~180분/);
await assert.rejects(mark("cA", "s1", "present", { lateMinutes: 10 }), /요청이 올바르지 않습니다/);

// 권한 = 출석·결석과 같음: 그 반 선생님 ✓, 다른 반 선생님·반 관리만 ✗, 출결 직원 ✓
await as(tB);
await assert.rejects(mark("cA", "s1", "late", { lateMinutes: 10 }), /권한/);
await as(classesOnly);
await assert.rejects(mark("cA", "s1", "late", { lateMinutes: 10 }), /권한/);
await as(tA);
const late1 = await mark("cA", "s1", "late", { lateMinutes: 10, via: "teacher_my_classes" });
assert.equal(late1.changed, true);
assert.equal(late1.status, "late");
let rec = await classDoc("cA", "s1");
assert.equal(rec.status, "late");
assert.equal(rec.lateMinutes, 10);
let n = (await notifs({ studentId: "s1", kind: "late" }))[0];
assert.equal(n.context, "class");
assert.equal(n.lateMinutes, 10);
assert.match(n.body, /S1 학생이 A반 수업에 지각하였습니다\(10분\)\. \(수업 시간 15:00~17:00 \/ 알림 전송 시각 \d\d:\d\d\)/);

// ★2 분만 바꾸기 — 알림 없음 + 정정 이력
const s1NotifsBefore = await notifCount({ studentId: "s1" });
const late2 = await mark("cA", "s1", "late", { lateMinutes: 15, via: "teacher_my_classes" });
assert.equal(late2.minutesOnly, true);
assert.equal(late2.notification, null);
assert.equal((await classDoc("cA", "s1")).lateMinutes, 15);
assert.equal(await notifCount({ studentId: "s1" }), s1NotifsBefore, "분만 바꾸면 알림 없음");
let cs = await corrections({ studentId: "s1", layer: "class" });
assert.equal(cs.length, 1);
assert.equal(cs[0].before.lateMinutes, 10);
assert.equal(cs[0].after.lateMinutes, 15);
assert.equal(cs[0].via, "teacher_my_classes");
assert.equal(cs[0].byName, "A선생");
assert.equal((await mark("cA", "s1", "late", { lateMinutes: 15 })).changed, false, "같은 분은 그대로");

// 상태 바뀌면 알림: 지각 → 출석(분 지움) → 결석 → 지각
assert.equal((await mark("cA", "s1", "present")).changed, true);
rec = await classDoc("cA", "s1");
assert.equal(rec.status, "present");
assert.equal(rec.lateMinutes, undefined);
assert.equal(await notifCount({ studentId: "s1" }), s1NotifsBefore + 1);
await mark("cA", "s1", "absent");
assert.equal((await classDoc("cA", "s1")).reason, "general");
await mark("cA", "s1", "late", { lateMinutes: 5 });
rec = await classDoc("cA", "s1");
assert.equal(rec.reason, undefined, "지각은 사유 없음");
assert.equal(await notifCount({ studentId: "s1" }), s1NotifsBefore + 3);

// 지각 기록 취소(정정 알림)
await as(attStaff);
assert.equal((await cancelClass("cA", "s1")).cancelled, "late");
n = (await notifs({ studentId: "s1", action: "cancel" }))[0];
assert.equal(n.kind, "late");
assert.match(n.body, /S1 학생의 A반 수업 지각 기록이 취소되었습니다/);

// 지난 날짜 정정 — 같은 창, 알림 없음·정정 이력
await as(owner);
await fixArrival("s2", Y1, "present", { arrivedAtTime: "15:20" });
const y1NotifsBefore = await notifCount();
assert.equal((await fixClass("cA", "s2", Y1, "late", { lateMinutes: 20 })).changed, true);
rec = await classDoc("cA", "s2", Y1);
assert.equal(rec.status, "late");
assert.equal(rec.lateMinutes, 20);
await assert.rejects(fixClass("cA", "s2", Y1, "late"), /지각 시간은 1~180분/);
assert.equal((await fixClass("cA", "s2", Y1, "late", { lateMinutes: 20 })).changed, false);
assert.equal((await fixClass("cA", "s2", Y1, "late", { lateMinutes: 25 })).changed, true);
cs = await corrections({ studentId: "s2", layer: "class" });
assert.equal(cs.at(-1).after.lateMinutes, 25);
assert.equal(await notifCount(), y1NotifsBefore, "지난 날짜 정정은 알림 없음");

// ★3 일괄 출석·결석은 지각 줄을 건너뜀
await arrive("s3");
await mark("cA", "s3", "late", { lateMinutes: 7 });
const bLate = await batch({ date: TODAY, mode: "today", action: "class_present", studentIds: ["s3"] });
assert.equal(bLate.results[0].result, "blocked");
assert.match(bLate.results[0].message, /지각으로 기록되어 있어 건너뛰었습니다/);
assert.equal((await classDoc("cA", "s3")).status, "late");
await assert.rejects(batch({ date: TODAY, mode: "today", action: "class_late", studentIds: ["s3"] }), /요청이 올바르지 않습니다/);

// ───────────────────── 하원 ─────────────────────
// H2: 등원 기록 없음·미등원 거부
await assert.rejects(depart("s4"), /오늘 등원 기록이 없어 하원 처리할 수 없습니다/);
await arrive("s4", "absent");
await assert.rejects(depart("s4"), /오늘 미등원으로 기록된 학생이라 하원 처리할 수 없습니다/);
await arrive("s4", "present");
// 권한 = 등원과 같음
await as(classesOnly);
await assert.rejects(depart("s4"), /담당 반 학생만 하원 처리할 수 있습니다/);
await as(tB);
await assert.rejects(depart("s4"), /담당 반 학생만 하원 처리할 수 있습니다/);
await as(tA);
const d1 = await depart("s4", { via: "teacher_my_classes" });
assert.equal(d1.changed, true);
let a = await arrivalDoc("s4");
assert.equal(a.departed, true);
assert.ok(a.leftAt instanceof Timestamp);
assert.equal(a.leftVia, "teacher_my_classes");
n = (await notifs({ studentId: "s4", context: "departure" }))[0];
assert.equal(n.kind, "left");
assert.match(n.body, /^S4 학생이 하원하였습니다\. \(알림 전송 시각 \d\d:\d\d\)$/);
// H3: 이미 하원 — 기록·알림 그대로
const s4n = await notifCount({ studentId: "s4" });
const d2 = await depart("s4");
assert.equal(d2.changed, false);
assert.equal(d2.message, "이미 하원 처리되었습니다.");
assert.equal(await notifCount({ studentId: "s4" }), s4n);
// ★5: 하원이 있으면 미등원·등원 취소 거부
await assert.rejects(arrive("s4", "absent"), /하원 기록이 있어 미등원으로 바꿀 수 없습니다\. 하원 기록을 먼저 취소해 주세요/);
await assert.rejects(
  call("cancelStudentArrival", { academyId: A, studentId: "s4", date: TODAY }),
  /하원 기록이 있어 등원 기록을 취소할 수 없습니다/,
);
// 하원 취소(정정 알림) → 하원 필드 없음 → 미등원 가능, 하원 필드가 남지 않음
assert.equal((await cancelDepart("s4")).changed, true);
n = (await notifs({ studentId: "s4", context: "departure", action: "cancel" }))[0];
assert.match(n.body, /S4 학생의 하원 기록이 취소되었습니다/);
assert.equal((await cancelDepart("s4")).changed, false);
await arrive("s4", "absent");
a = await arrivalDoc("s4");
assert.equal(a.status, "absent");
for (const f of ["departed", "leftAt", "leftAtManual", "leftByUid", "leftVia"]) assert.equal(a[f], undefined, f);
await assert.rejects(call("cancelStudentDeparture", { academyId: A, studentId: "s4", date: Y1 }), /오늘 기록만 취소/);

// 차감 잠금 날도 허용(H3)
await as(owner);
await arrive("s5");
await arrivalRef("s5", TODAY).update({ billedInvoicePeriod: "2026-11" });
assert.equal((await depart("s5")).changed, true);

// B5: 하원 하루 10회는 등원과 따로
await arrive("s6");
await db.doc(`_pushRateLimits/attendance_${A}_s6`).set({ changeDay: TODAY, changeCount: 10 });
const dep6 = await depart("s6");
assert.notEqual(dep6.notification.reason, "daily_limit", "등원 키가 가득 차도 하원 알림은 나감");
assert.equal((await db.doc(`_pushRateLimits/departure_${A}_s6`).get()).get("changeCount"), 1);
await db.doc(`_pushRateLimits/departure_${A}_s6`).set({ changeDay: TODAY, changeCount: 10 });
const cancel6 = await cancelDepart("s6");
assert.equal(cancel6.notification.reason, "daily_limit");

// ★7 오늘 하원 시각만 고침
await depart("s6");
await assert.rejects(fixDepart("s6", TODAY, false), /오늘 기록은 시각만/);
await assert.rejects(fixDepart("s7", TODAY, true, { leftAtTime: "00:00" }), /오늘 기록은 시각만/);
// R1 시각 지우기(null) 거부, 지금보다 늦은 시각 거부
await assert.rejects(fixDepart("s6", TODAY, true, { leftAtTime: null }), /오늘 기록은 시각만/);
if (NOW_HM < "23:59") {
  await assert.rejects(fixDepart("s6", TODAY, true, { leftAtTime: "23:59" }), /오늘 기록은 지금보다 늦은 시각으로 고칠 수 없습니다/);
  await assert.rejects(fixArrival("s6", TODAY, "present", { arrivedAtTime: "23:59" }), /지금보다 늦은 시각/);
}
// 등원 00:00 ≤ 하원 00:01 ≤ 지금 — 서울 00:05 전이면 건너뜀
if (NOW_HM >= "00:05") {
  const s6n = await notifCount({ studentId: "s6" });
  assert.equal((await fixArrival("s6", TODAY, "present", { arrivedAtTime: "00:00" })).changed, true);
  assert.equal((await fixDepart("s6", TODAY, true, { leftAtTime: "00:01" })).changed, true);
  a = await arrivalDoc("s6");
  assert.equal(a.leftAt.toMillis(), seoulMs(TODAY, "00:01"));
  assert.equal(a.leftAtManual, true);
  assert.equal(await notifCount({ studentId: "s6" }), s6n);
} else {
  console.log("  (서울 00:05 전 — 오늘 시각 고치기 단계 건너뜀)");
}

// 지난 날짜 하원 정정(알림 없음·정정 이력 layer departure) + ★6
await fixArrival("s7", Y1, "present", { arrivedAtTime: "14:00" });
const pastNotifs = await notifCount();
await assert.rejects(fixDepart("s7", Y1, true, { leftAtTime: "13:00" }), /하원 시각은 등원 시각보다 빠를 수 없습니다/);
await assert.rejects(fixDepart("s8", Y1, true), /등원 기록이 없어 하원을 기록할 수 없습니다/);
await assert.rejects(fixDepart("s7", TOMORROW, true), /앞으로의 날짜/);
assert.equal((await fixDepart("s7", Y1, true, { leftAtTime: "18:00" })).changed, true);
assert.equal((await fixDepart("s7", Y1, true, { leftAtTime: "18:00" })).changed, false);
assert.equal((await fixDepart("s7", Y1, true, { leftAtTime: "18:30" })).changed, true);
a = await arrivalDoc("s7", Y1);
assert.equal(a.leftAt.toMillis(), seoulMs(Y1, "18:30"));
assert.ok(a.correctedAt);
// 등원 시각을 하원보다 늦게 고치면 거부(★6)
await assert.rejects(fixArrival("s7", Y1, "present", { arrivedAtTime: "19:00" }), /하원 시각은 등원 시각보다 빠를 수 없습니다/);
// ★5 지난 날짜: 미등원·지우기·기록 삭제·기간 결석 거부
await assert.rejects(fixArrival("s7", Y1, "absent"), /하원 기록이 있어 미등원으로 바꿀 수 없습니다\. 하원 기록을 먼저 정정해 주세요/);
await assert.rejects(fixArrival("s7", Y1, null), /하원 기록이 있어 등원 기록을 지울 수 없습니다/);
await assert.rejects(
  call("deleteStudentAttendanceRecord", { academyId: A, studentId: "s7", date: Y1 }),
  /하원 기록이 있어 등원 기록을 지울 수 없습니다/,
);
await assert.rejects(
  call("recordStudentAbsences", { academyId: A, studentId: "s7", reason: "illness", dates: [Y1] }),
  /하원 기록이 있어 결석으로 기록할 수 없습니다/,
);
let dcs = await corrections({ studentId: "s7", layer: "departure" });
assert.deepEqual(dcs.map((c) => c.action), ["create", "update"]);
assert.equal((await fixDepart("s7", Y1, false)).changed, true);
a = await arrivalDoc("s7", Y1);
assert.equal(a.departed, undefined);
assert.equal((await fixArrival("s7", Y1, "absent")).changed, true, "하원 정정 뒤에는 미등원 가능");
assert.equal(await notifCount(), pastNotifs, "지난 날짜 하원 정정은 알림 없음");
dcs = await corrections({ studentId: "s7", layer: "departure" });
assert.equal(dcs.at(-1).action, "delete");

// 일괄 하원 — 오늘 알림, 지난 날짜 무알림·시각 없음
await arrive("s8");
await arrive("s9");
const bd = await batch({ date: TODAY, mode: "today", action: "depart", studentIds: ["s8", "s9", "s10"] });
assert.deepEqual(bd.results.map((r) => r.result), ["changed", "changed", "blocked"]);
assert.match(bd.results[2].message, /오늘 등원 기록이 없어 하원/);
assert.equal(await notifCount({ studentId: "s8", context: "departure" }), 1);
await fixArrival("s9", Y2, "present");
const before = await notifCount();
const bp = await batch({ date: Y2, mode: "past", action: "depart", studentIds: ["s9", "s10"] });
assert.deepEqual(bp.results.map((r) => r.result), ["changed", "blocked"]);
a = await arrivalDoc("s9", Y2);
assert.equal(a.departed, true);
assert.equal(a.leftAt, undefined, "지난 날짜 일괄 하원은 시각 없음");
assert.equal(await notifCount(), before);

// 키오스크 모드 공용 로직(B10) — functions 빌드 결과를 직접 불러 같은 에뮬레이터에서
{
  const requireCjs = createRequire(import.meta.url);
  const fAdmin = requireCjs("../../functions/node_modules/firebase-admin");
  if (!fAdmin.apps.length) fAdmin.initializeApp({ projectId: PROJECT });
  const { recordDepartureCore } = requireCjs("../../functions/lib/attendance-departure.js");
  const fdb = fAdmin.firestore();
  const sender = { role: "student_kiosk", actorUid: "kiosk-uid", source: "student_kiosk" };
  const kiosk = async (sid) =>
    recordDepartureCore(fdb, {
      mode: "kiosk", academyId: A, studentId: sid, sender,
      studentData: (await db.doc(`academies/${A}/students/${sid}`).get()).data(),
    });
  await assert.rejects(kiosk("s11"), /오늘 등원 기록이 없어요\. 선생님께 말씀해 주세요\./);
  await arrive("s11", "absent");
  await assert.rejects(kiosk("s11"), /오늘 등원 기록이 없어요/);
  await arrive("s11", "present");
  await arrivalRef("s11", TODAY).update({ billedInvoicePeriod: "2026-11" });
  const k1 = await kiosk("s11");
  assert.equal(k1.changed, true);
  a = await arrivalDoc("s11");
  assert.equal(a.leftVia, "kiosk");
  assert.equal(a.leftSource, "student_kiosk");
  const k2 = await kiosk("s11");
  assert.equal(k2.alreadyLeft, true);
  assert.equal(k2.message, "이미 하원 처리되었습니다.");
  assert.equal(await notifCount({ studentId: "s11", context: "departure" }), 1, "키오스크 다시 누름은 알림 그대로");
}

// ───────────────────── 휴강 ─────────────────────
const lessonNotifs = await notifCount();
await as(tA);
await assert.rejects(cancelLesson("cC", TODAY, true), /휴강은 원장이나 출결 권한이 있는 직원만/);
await as(classesOnly);
await assert.rejects(cancelLesson("cC", TODAY, true), /휴강은 원장이나 출결 권한/);
await as(attStaff);
// 그날 그 반 출결이 있으면 거부(cA는 오늘 기록 있음)
await assert.rejects(cancelLesson("cA", TODAY, true), new RegExp(`A반 수업 출결 기록이 \\d+건 있어 휴강으로 기록할 수 없습니다`));
await assert.rejects(cancelLesson("cEnd", TODAY, true), /종강한 반은 휴강으로 기록할 수 없습니다/);
await assert.rejects(cancelLesson("cB", TODAY, true), /오늘은 이 반 수업이 없어 휴강으로 기록할 수 없습니다/);
await assert.rejects(cancelLesson("cC", TOMORROW, true), /앞으로의 날짜는 휴강으로 기록할 수 없습니다/);
await assert.rejects(cancelLesson("nope", Y1, true), /반을 찾을 수 없습니다/);
const cc = await cancelLesson("cC", TODAY, true, { memo: "  선생님 출장  " });
assert.equal(cc.changed, true);
const cdoc = (await db.doc(`academies/${A}/classCancellations/${TODAY}_cC`).get()).data();
assert.equal(cdoc.memo, "선생님 출장");
assert.equal(cdoc.className, "C반");
assert.deepEqual(cdoc.slots, [{ start: "15:00", end: "17:00" }]);
assert.equal(cdoc.byName, "출결 직원");
// 휴강 반 출결 거부 — 오늘 버튼·일괄
await arrive("c1");
await assert.rejects(mark("cC", "c1", "present"), /휴강한 수업이라 출결을 기록할 수 없습니다\. 휴강을 먼저 취소해 주세요\./);
await assert.rejects(mark("cC", "c1", "late", { lateMinutes: 5 }), /휴강한 수업이라/);
const bc = await call("recordAttendanceBatch", {
  academyId: A, classId: "cC", date: TODAY, mode: "today", action: "class_present", studentIds: ["c1"],
});
assert.match(bc.results[0].message, /휴강한 수업이라/);
// 메모만 바꾸기 → 이력 detail, 취소 → delete, 다시 취소 → 그대로
assert.equal((await cancelLesson("cC", TODAY, true, { memo: "학원 사정" })).changed, true);
assert.equal((await cancelLesson("cC", TODAY, true)).changed, false);
assert.equal((await cancelLesson("cC", TODAY, false)).changed, true);
assert.equal((await cancelLesson("cC", TODAY, false)).changed, false);
let lc = await corrections({ classId: "cC", layer: "class_cancel" });
assert.deepEqual(lc.map((c) => c.action), ["create", "detail", "delete"]);
assert.equal(lc[1].after.memo, "학원 사정");
assert.equal((await mark("cC", "c1", "present")).changed, true, "휴강 취소 뒤 출결 가능");

// P1 지난 날짜: 지금 종강한 반·수업 없는 요일도 기록 가능(반 있음 + 출결 0건)
await as(owner);
assert.equal((await cancelLesson("cEnd", Y2, true)).changed, true);
assert.equal((await cancelLesson("cB", Y1, true)).changed, true);
// 지난 날짜: 출결이 있으면 거부 → 지우고 휴강 → 휴강 반 정정 거부
await fixArrival("c2", Y1, "present");
await fixClass("cC", "c2", Y1, "present");
await assert.rejects(cancelLesson("cC", Y1, true), /C반 수업 출결 기록이 1건 있어 휴강으로/);
await fixClass("cC", "c2", Y1, null);
assert.equal((await cancelLesson("cC", Y1, true)).changed, true);
await assert.rejects(fixClass("cC", "c2", Y1, "present"), /휴강한 수업이라/);
// 3-B 후속 Q2: 반 관리 목록(via class_list)의 오늘 휴강 — 정정 이력에 실제 경로
assert.equal((await cancelLesson("cDel", TODAY, true, { via: "class_list" })).changed, true);
assert.equal((await corrections({ classId: "cDel", layer: "class_cancel" })).at(-1).via, "class_list");
await assert.rejects(cancelLesson("cDel", TODAY, false, { via: "class_detail" }), /요청 경로가 올바르지 않습니다/);
assert.equal((await cancelLesson("cDel", TODAY, false, { via: "class_list" })).changed, true);
// 삭제된 반의 휴강 취소
await cancelLesson("cDel", Y1, true);
await db.doc(`academies/${A}/classes/cDel`).delete();
assert.equal((await cancelLesson("cDel", Y1, false)).changed, true);
assert.equal(await notifCount(), lessonNotifs + 2, "휴강은 학부모 알림 없음(+2 = c1 등원·휴강 취소 뒤 출석)");

// ───────────────────── 출결 설정·알림 꺼짐 ─────────────────────
await as(tA);
await assert.rejects(settings(ALL_ON), /출결 설정은 원장이나 출결 권한/);
await as(attStaff);
await assert.rejects(settings({ ...ALL_ON, departure: "no" }), /요청이 올바르지 않습니다/);
await assert.rejects(settings({ arrival: true }), /요청이 올바르지 않습니다/);
await assert.rejects(settings({ ...ALL_ON, extra: true }), /요청이 올바르지 않습니다/);
await settings({ ...ALL_ON, departure: false, classLate: false });
assert.equal((await db.doc(`academies/${A}/meta/attendanceSettings`).get()).get("notify.departure"), false);
await arrive("s12");
const bells = await bellCount();
const dep12 = await depart("s12");
assert.equal(dep12.notification.reason, "muted");
n = (await notifs({ studentId: "s12", context: "departure" }))[0];
assert.equal(n.muted, true);
assert.equal(await bellCount(), bells, "끈 종류는 벨 없음");
assert.equal((await db.doc(`_pushRateLimits/departure_${A}_s12`).get()).exists, false, "끈 종류는 하루 10회에 안 셈");
assert.equal((await mark("cA", "s12", "late", { lateMinutes: 3 })).notification.reason, "muted");
assert.notEqual((await mark("cA", "s12", "present")).notification.reason, "muted", "켠 종류는 그대로");

// 3-B 후속 F2: 취소 알림 = 원래 종류 그리고 정정(지금 설정: 하원·수업 지각 끔, 정정 켬)
const latestCancel = async (sid, context) =>
  (await notifs({ studentId: sid, context, action: "cancel" })).sort((x, y) => y.createdAt.toMillis() - x.createdAt.toMillis())[0];
const cancelCount = async (sid) => (await notifs({ studentId: sid, action: "cancel" })).length;
await arrive("s15");
await depart("s15");
let bellsF2 = await bellCount();
// ① 하원 끔 + 정정 켬 → 하원 취소 muted(벨 없음)
assert.equal((await cancelDepart("s15")).changed, true);
assert.equal(await cancelCount("s15"), 1);
assert.equal((await latestCancel("s15", "departure")).muted, true, "하원 끔 → 하원 취소 muted");
assert.equal(await bellCount(), bellsF2, "꺼 둔 종류의 취소는 벨 없음");
// ② 수업 지각 끔 → 지각 기록 취소 muted
await mark("cA", "s15", "late", { lateMinutes: 4 });
assert.equal((await cancelClass("cA", "s15")).cancelled, "late");
assert.equal((await latestCancel("s15", "class")).muted, true, "수업 지각 끔 → 지각 기록 취소 muted");
assert.equal(await bellCount(), bellsF2);
// ③ 하원 켬 + 정정 끔 → muted
await settings({ ...ALL_ON, correction: false });
await depart("s15");
bellsF2 = await bellCount();
await cancelDepart("s15");
assert.equal(await cancelCount("s15"), 3);
assert.equal((await latestCancel("s15", "departure")).muted, true, "정정 끔 → 하원 취소 muted");
assert.equal(await bellCount(), bellsF2);
// ④ 둘 다 켬 → 전송
await settings(ALL_ON);
await depart("s15");
bellsF2 = await bellCount();
await cancelDepart("s15");
assert.equal(await cancelCount("s15"), 4);
const sentCancel = await latestCancel("s15", "departure");
assert.equal(sentCancel.muted, undefined, "둘 다 켬 → 하원 취소 전송");
assert.equal(await bellCount(), bellsF2 + 1);
// ⑤ 다시 보내기도 같은 판단 — 하원 끔(정정 켬)이면 하원 취소 알림 거부, 정정만 꺼도 거부
await settings({ ...ALL_ON, departure: false });
await assert.rejects(resend(sentCancel.id), /출결 설정에서 꺼 둔 알림이라 다시 보낼 수 없습니다/);
await settings({ ...ALL_ON, correction: false });
await assert.rejects(resend(sentCancel.id), /출결 설정에서 꺼 둔 알림이라 다시 보낼 수 없습니다/);
// 아래 다시 보내기 절이 기대하는 설정으로 되돌림
await settings({ ...ALL_ON, departure: false, classLate: false });

// ───────────────────── 다시 보내기 ─────────────────────
await arrive("s13");
const s13Arrival = (await notifs({ studentId: "s13", context: "arrival" }))[0];
await as(tA);
await assert.rejects(resend(s13Arrival.id), /알림 다시 보내기는 원장이나 출결 권한/);
await as(attStaff);
const rs = await resend(s13Arrival.id);
assert.notEqual(rs.notification.reason, "muted");
n = (await notifs({ studentId: "s13", resend: true }))[0];
assert.equal(n.resendOfId, s13Arrival.id);
assert.match(n.body, /^\(다시 알림\) S13 학생이 안전하게 등원하였습니다\./);
assert.equal(n.senderUid, attStaff.uid);
// 꺼진 종류(하원) 거부
const muted12 = (await notifs({ studentId: "s12", context: "departure" }))[0];
await assert.rejects(resend(muted12.id), /출결 설정에서 꺼 둔 알림이라 다시 보낼 수 없습니다/);
await settings(ALL_ON);
assert.ok((await resend(muted12.id)).notification, "켜면 다시 보낼 수 있음(지금 설정 기준)");
// 상태가 바뀌면 거부
await arrive("s13", "absent");
await assert.rejects(resend(s13Arrival.id), /지금 출결 기록이 이 알림과 달라 다시 보낼 수 없습니다/);
// 오늘 아닌 알림 거부, 없는 알림
const oldRef = await db.collection(`academies/${A}/attendanceNotifications`).add({
  kind: "present", context: "arrival", date: Y1, studentId: "s13", createdAt: Timestamp.fromMillis(seoulMs(Y1, "15:00")),
});
await assert.rejects(resend(oldRef.id), /오늘 보낸 알림만 다시 보낼 수 있습니다/);
await assert.rejects(resend("nope"), /알림 기록을 찾을 수 없습니다/);
// 하루 10회에 셈
const s13Absent = (await notifs({ studentId: "s13", kind: "absent" }))[0];
await db.doc(`_pushRateLimits/attendance_${A}_s13`).set({ changeDay: TODAY, changeCount: 10 });
assert.equal((await resend(s13Absent.id)).notification.reason, "daily_limit");

// 알림 기록 목록 응답(3-B 필드)
const list = await call("listAttendanceNotifications", { academyId: A, limit: 100 });
const listed = list.items.find((x) => x.id === muted12.id);
assert.equal(listed.context, "departure");
assert.equal(listed.kind, "left");
assert.equal(listed.muted, true);
assert.equal(listed.date, TODAY);
assert.ok(list.items.some((x) => x.resend === true));
assert.ok(list.items.some((x) => x.kind === "late" && x.lateMinutes === 10));

// ───────────────────── 학부모 출결 기록 ─────────────────────
await as(owner);
await fixArrival("s14", Y1, "present", { arrivedAtTime: "15:05" });
await call("updateAttendanceDetails", { academyId: A, layer: "arrival", studentId: "s14", date: Y1, note: "학원 메모 비밀" });
await fixDepart("s14", Y1, true, { leftAtTime: "18:10" });
await fixClass("cA", "s14", Y1, "late", { lateMinutes: 5 });
await call("updateAttendanceDetails", { academyId: A, layer: "class", classId: "cA", studentId: "s14", date: Y1, note: "코멘트 비밀" });
await cancelLesson("cA", Y2, true, { memo: "휴강 메모 비밀" });
await fixArrival("s14", shift(-3), "absent", { reason: "illness" });
await db.doc(`academies/${A}/students/s14/attendanceRecords/${OLD40}`).set({
  date: OLD40, status: "present", academyId: A, studentId: "s14",
});

await as(parent);
const h = await history("s14");
assert.equal(h.to, TODAY);
assert.equal(h.from, shift(-30));
const byDate = new Map(h.days.map((d) => [d.date, d]));
assert.equal(byDate.has(OLD40), false, "31일 밖은 없음");
const dY1 = byDate.get(Y1);
assert.deepEqual(dY1.arrival, { status: "present", arrivedAt: "15:05", departed: true, leftAt: "18:10", reason: null });
assert.deepEqual(dY1.classes, [{ classId: "cA", className: "A반", status: "late", lateMinutes: 5, reason: null }]);
assert.equal(dY1.corrected, true);
const dY2 = byDate.get(Y2);
assert.equal(dY2.arrival, null, "P2 휴강만 있는 날도 포함");
assert.deepEqual(dY2.cancellations, [{ classId: "cA", className: "A반" }]);
assert.equal(byDate.get(shift(-3)).arrival.reason, "illness");
const raw = JSON.stringify(h);
assert.ok(!/비밀|note|comment|memo|byName|recordedByUid/.test(raw), "메모·코멘트·휴강 메모·처리자 없음");
assert.deepEqual(h.days.map((d) => d.date), [...h.days.map((d) => d.date)].sort().reverse(), "최근 날짜부터");
// 다른 학부모·비활성 학부모·직원·연결 없는 자녀·퇴원 자녀 거부
await assert.rejects(history("hx"), /연결된 자녀의 출결 기록만/);
await as(otherParent);
await assert.rejects(history("s14"), /연결된 자녀의 출결 기록만 볼 수 있습니다/);
await as(inactiveParent);
await assert.rejects(history("s14"), /활성 학부모만/);
await as(owner);
await assert.rejects(history("s14"), /활성 학부모만/);

await signOut(auth);
console.log("attendance-3b smoke OK");
process.exit(0);
