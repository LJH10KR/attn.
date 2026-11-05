/**
 * 2-I 등원·반 출결 스모크 — `npm run test:functions` (Auth·Firestore·Functions 에뮬레이터)
 * 권한(원장·출결 직원·그 반 선생님·다른 반 선생님·반 관리만 직원), 반 출결 조건별 오류, 상태 전환(같은 상태 = 그대로),
 * 등원→미등원은 반 출결 0건일 때만, 기간 결석·기록 삭제 거부(반 출결 있는 날), via 허용 목록,
 * 키오스크 재체크인, 하루 10회 제한, 등원 키 공유(기간 결석 60초 쿨다운과 서로 막지 않음, B5),
 * 예전 sendStudentAttendanceNotification 호환(B3), 월정액 결석 차감 회귀 + 차감 잠금(★8·B2),
 * 알림 문서 context·className·벨 문구, 알림 기록 응답, saveClass 요일당 1칸, 학생 삭제 시 반 출결 삭제를 확인한다.
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
const A = "o9_att";

const SEOUL_WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const now = new Date();
const TODAY = now.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
const WD = SEOUL_WEEKDAY[new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(now)];
const OTHER_WD = (WD % 7) + 1;
const TOMORROW = new Date(Date.parse(`${TODAY}T12:00:00+09:00`) + 86400000).toLocaleDateString("en-CA", {
  timeZone: "Asia/Seoul",
});
const DAY_AFTER = new Date(Date.parse(`${TODAY}T12:00:00+09:00`) + 2 * 86400000).toLocaleDateString("en-CA", {
  timeZone: "Asia/Seoul",
});

const mkUser = (email) => adminAuth().createUser({ email, password: "pass1234", emailVerified: true });
const owner = await mkUser("owner-att@t.dev");
const attStaff = await mkUser("att-staff@t.dev");
const classesOnly = await mkUser("att-cls@t.dev");
const tA = await mkUser("att-ta@t.dev");
const tB = await mkUser("att-tb@t.dev");
const stranger = await mkUser("att-stranger@t.dev");

await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "출결 학원", status: "active" });
const staff = (u, permissions) =>
  db.doc(`academies/${A}/staff/${u.uid}`).set({
    authUid: u.uid, displayName: u.email, status: "active", roleId: "x", permissions, employmentStatus: "employed",
  });
await staff(attStaff, ["lessons.attendance"]);
await staff(classesOnly, ["operations.classes"]);
await staff(tA, []);
await staff(tB, []);
await db.doc(`academies/${A}/parents/p9`).set({ authUid: "p9", displayName: "보호자", status: "active" });

const todaySlot = { weekday: WD, start: "15:00", end: "17:00" };
const cls = (name, extra) => ({ name, status: "active", sortOrder: 0, roomId: null, capacity: null, ...extra });
await db.doc(`academies/${A}/classes/cA`).set(cls("A반", { schedule: [todaySlot], teacherUids: [tA.uid] }));
await db.doc(`academies/${A}/classes/cB`).set(cls("B반", { schedule: [todaySlot], teacherUids: [tB.uid] }));
await db.doc(`academies/${A}/classes/cNo`).set(
  cls("쉬는반", { schedule: [{ weekday: OTHER_WD, start: "15:00", end: "16:00" }], teacherUids: [tA.uid] }),
);
await db.doc(`academies/${A}/classes/cEnd`).set(cls("끝난반", { status: "ended", schedule: [todaySlot], teacherUids: [] }));
/** 예전 데이터 — 같은 요일 두 칸 */
await db.doc(`academies/${A}/classes/cLegacy`).set(
  cls("두번반", {
    schedule: [
      { weekday: WD, start: "15:00", end: "16:00" },
      { weekday: WD, start: "18:00", end: "19:00" },
    ],
    teacherUids: [],
  }),
);

const student = (id, extra) =>
  db.doc(`academies/${A}/students/${id}`).set({
    name: id.toUpperCase(), status: "enrolled", grade: "e3", gradeYear: 2026, guardians: [], guardianPhones: [],
    parentUids: ["p9"], classIds: ["cA"], teacherUids: [tA.uid], ...extra,
  });
await student("s1", { classIds: ["cA", "cNo", "cEnd"] });
await student("s2", { classIds: ["cB"], teacherUids: [tB.uid] });
await student("s3", { status: "on_leave" });
await student("s5", {});
await student("s6", {});
await student("s8", { classIds: ["cA", "cLegacy"] });
const dueDay = Number(TODAY.slice(8)) <= 27 ? 28 : 1;
await student("s7", { tuitionType: "monthly_fixed", tuitionAmount: 100000, tuitionDueDayOfMonth: dueDay });
const thisPeriod = TODAY.slice(0, 7);
const [py, pm] = thisPeriod.split("-").map(Number);
const PERIOD =
  dueDay === 28 ? thisPeriod : `${pm === 12 ? py + 1 : py}-${String(pm === 12 ? 1 : pm + 1).padStart(2, "0")}`;

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
const arrivalDoc = async (sid, date = TODAY) =>
  (await db.doc(`academies/${A}/students/${sid}/attendanceRecords/${date}`).get()).data();
const classDoc = async (classId, sid) =>
  (await db.doc(`academies/${A}/attendance/${TODAY}_${classId}_${sid}`).get()).data();
const notifs = async (sid) =>
  (await db.collection(`academies/${A}/attendanceNotifications`).where("studentId", "==", sid).get()).docs
    .map((d) => d.data())
    .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
const bells = async () =>
  (await db.collection("users/p9/dashboardBellItems").orderBy("createdAt", "asc").get()).docs.map((d) => d.data());
const lastBell = async (sid) => (await bells()).filter((b) => b.studentId === sid).at(-1);
const HHMM = /\(알림 전송 시각 ([01]\d|2[0-3]):[0-5]\d\)$/;

// --- 권한 ---
await as(tB);
await assert.rejects(call("recordStudentArrival", { ...arrival("s1"), status: "present" }), /담당 반 학생만/);
await assert.rejects(call("recordClassAttendance", { ...klass("cA", "s1"), status: "present" }), /권한/);
await as(classesOnly);
await assert.rejects(call("recordStudentArrival", { ...arrival("s1"), status: "present" }), /담당 반 학생만/);
await assert.rejects(call("recordClassAttendance", { ...klass("cA", "s1"), status: "present" }), /권한/);
await as(stranger);
await assert.rejects(call("recordStudentArrival", { ...arrival("s1"), status: "present" }), /권한/);
await assert.rejects(call("recordClassAttendance", { ...klass("cA", "s1"), status: "present" }), /권한/);

// --- via 허용 목록(B4) ---
await as(tA);
await assert.rejects(call("recordStudentArrival", { ...arrival("s1"), status: "present", via: "kiosk" }), /경로/);
await assert.rejects(call("recordClassAttendance", { ...klass("cA", "s1"), status: "present", via: "student_list" }), /경로/);

// --- 반 출결: 등원 전 → 미등원 → 등원 ---
await assert.rejects(call("recordClassAttendance", { ...klass("cA", "s1"), status: "present" }), /아직 등원 처리되지 않았습니다/);
const absent1 = await call("recordStudentArrival", { ...arrival("s1"), status: "absent", via: "teacher_my_classes" });
assert.equal(absent1.changed, true);
assert.equal((await arrivalDoc("s1")).status, "absent");
assert.equal((await arrivalDoc("s1")).reason, "general");
assert.match((await lastBell("s1")).body, /^S1 학생이 아직 등원하지 않았습니다\. /);
assert.match((await lastBell("s1")).body, HHMM);
await assert.rejects(call("recordClassAttendance", { ...klass("cA", "s1"), status: "present" }), /미등원으로 기록된/);

const present1 = await call("recordStudentArrival", { ...arrival("s1"), status: "present", via: "teacher_my_classes" });
assert.equal(present1.changed, true, "미등원 → 등원(늦게 온 경우) 허용");
const a1 = await arrivalDoc("s1");
assert.equal(a1.status, "present");
assert.equal(a1.reason, undefined);
assert.ok(a1.arrivedAt && a1.statusChangedAt);
assert.equal(a1.via, "teacher_my_classes");
assert.equal(a1.recordedByRole, "teacher");
assert.equal(a1.source, "teacher_dashboard");
assert.equal(a1.academyId, A);
assert.equal(a1.studentId, "s1");
assert.match((await lastBell("s1")).body, /^S1 학생이 안전하게 등원하였습니다\. \(알림 전송 시각 \d\d:\d\d\)$/);

const before = (await notifs("s1")).length;
const same = await call("recordStudentArrival", { ...arrival("s1"), status: "present" });
assert.equal(same.changed, false, "같은 상태 = 그대로(★2)");
assert.equal(same.notification, null);
assert.equal((await notifs("s1")).length, before, "같은 상태는 알림 없음");

// --- 반 출석 → 결석 정정(쿨다운에 막히지 않음) ---
const c1 = await call("recordClassAttendance", { ...klass("cA", "s1"), status: "present", via: "teacher_my_classes" });
assert.equal(c1.changed, true);
const cd = await classDoc("cA", "s1");
assert.equal(cd.status, "present");
assert.equal(cd.className, "A반");
assert.deepEqual(cd.slots, [{ start: "15:00", end: "17:00" }]);
assert.equal(cd.markedByUid, tA.uid);
assert.equal(cd.markedByRole, "teacher");
assert.equal(cd.via, "teacher_my_classes");
assert.equal(cd.date, TODAY);
assert.match(
  (await lastBell("s1")).body,
  /^S1 학생이 A반 수업에 출석하였습니다\. \(수업 시간 15:00~17:00 \/ 알림 전송 시각 \d\d:\d\d\)$/,
);
assert.equal((await lastBell("s1")).kind, "class_present");
const nClass = (await notifs("s1")).at(-1);
assert.equal(nClass.context, "class");
assert.equal(nClass.classId, "cA");
assert.equal(nClass.className, "A반");
assert.equal(nClass.date, TODAY);
assert.equal((await call("recordClassAttendance", { ...klass("cA", "s1"), status: "present" })).changed, false);
const c2 = await call("recordClassAttendance", { ...klass("cA", "s1"), status: "absent" });
assert.equal(c2.changed, true);
assert.notEqual(c2.notification?.reason, "cooldown", "정정은 쿨다운에 막히지 않음");
assert.match((await lastBell("s1")).body, /^S1 학생이 A반 수업에 결석하였습니다\. \(수업 시간 15:00~17:00 \//);
assert.equal((await notifs("s1")).filter((n) => n.context === "arrival").at(-1).context, "arrival");

// --- 반 출결 조건별 오류 ---
await assert.rejects(call("recordClassAttendance", { ...klass("cNo", "s1"), status: "present" }), /오늘은 이 반 수업이 없습니다/);
await as(owner);
await assert.rejects(call("recordClassAttendance", { ...klass("cEnd", "s1"), status: "present" }), /종강한 반/);
await assert.rejects(call("recordClassAttendance", { ...klass("cB", "s1"), status: "present" }), /이 반 원생이 아닙니다/);
await assert.rejects(call("recordClassAttendance", { ...klass("nope", "s1"), status: "present" }), /반을 찾을 수 없습니다/);
await assert.rejects(call("recordStudentArrival", { ...arrival("s3"), status: "present" }), /재원/);
await assert.rejects(call("recordClassAttendance", { ...klass("cA", "s3"), status: "present" }), /재원/);

// --- 등원 → 미등원은 그날 반 출결 0건일 때만, 기간 결석·기록 삭제도 거부(★7) ---
await assert.rejects(call("recordStudentArrival", { ...arrival("s1"), status: "absent" }), /수업 출결이 1건 있어/);
await assert.rejects(
  call("recordStudentAbsences", { ...arrival("s1"), dates: [TODAY, TOMORROW], reason: "illness" }),
  /수업 출결 기록이 있어 결석으로/,
);
await assert.rejects(call("deleteStudentAttendanceRecord", { ...arrival("s1"), date: TODAY }), /수업 출결 기록이 있어/);
assert.equal((await arrivalDoc("s1", TOMORROW)), undefined, "거부되면 어느 날짜도 쓰지 않음");

// --- 출결 권한 직원은 모든 반·학생 ---
await as(attStaff);
assert.equal((await call("recordStudentArrival", { ...arrival("s2"), status: "present", via: "student_list" })).changed, true);
assert.equal((await call("recordClassAttendance", { ...klass("cB", "s2"), status: "present" })).changed, true);
assert.equal((await arrivalDoc("s2")).recordedByRole, "teacher");

// --- 원장 기록자 정보 ---
await as(owner);
await call("recordStudentArrival", { ...arrival("s8"), status: "present", via: "class_detail" });
assert.equal((await arrivalDoc("s8")).recordedByRole, "owner");
assert.equal((await arrivalDoc("s8")).source, "academy_dashboard");
// 예전 중복 반: 그날 시간을 모두 적음
await call("recordClassAttendance", { ...klass("cLegacy", "s8"), status: "present" });
assert.match((await lastBell("s8")).body, /\(수업 시간 15:00~16:00, 18:00~19:00 \//);

// --- 키오스크 재체크인: 기록·알림 그대로 ---
const kBefore = (await notifs("s1")).length;
const kiosk1 = await call("submitKioskCheckIn", arrival("s1"));
assert.equal(kiosk1.alreadyArrived, true);
assert.equal((await notifs("s1")).length, kBefore);
const kiosk2 = await call("submitKioskCheckIn", arrival("s5"));
assert.equal(kiosk2.alreadyArrived, false);
const k5 = await arrivalDoc("s5");
assert.equal(k5.status, "present");
assert.equal(k5.via, "kiosk");
assert.equal(k5.recordedByRole, "student_kiosk");
assert.match((await lastBell("s5")).body, /^S5 학생이 안전하게 등원하였습니다\. /);

// --- 등원 키 공유(B5): 하루 10회 세기(상태 바뀜)와 기간 결석 60초 쿨다운은 서로 막지 않는다 ---
const rateRef = db.doc(`_pushRateLimits/attendance_${A}_s5`);
assert.equal((await rateRef.get()).get("lastSentAt"), undefined, "상태 바뀜 알림은 lastSentAt을 쓰지 않음");
const period1 = await call("recordStudentAbsences", { ...arrival("s5"), dates: [TOMORROW], reason: "illness", notifyParent: true });
assert.equal(period1.recordedCount, 1);
assert.notEqual(period1.notification.reason, "cooldown", "등원(상태 바뀜) 알림 직후에도 기간 결석 알림은 나감");
assert.match((await lastBell("s5")).body, /^'S5' 학생이 결석 처리되었습니다\. \(.+ · 사유: 질병\)$/);
const period2 = await call("recordStudentAbsences", { ...arrival("s5"), dates: [DAY_AFTER], reason: "academy", notifyParent: true });
assert.equal(period2.recordedCount, 1);
assert.equal(period2.notification.reason, "cooldown", "기간 결석 알림 뒤 60초 안의 기간 결석 알림은 쿨다운");
assert.equal((await arrivalDoc("s5", DAY_AFTER)).reason, "academy", "쿨다운이어도 기록은 저장");
const lastSentBefore = (await rateRef.get()).get("lastSentAt").toMillis();
const flip = await call("recordStudentArrival", { ...arrival("s5"), status: "absent" });
assert.equal(flip.changed, true);
assert.notEqual(flip.notification.reason, "cooldown", "기간 결석 직후에도 상태 바뀜 알림은 나감");
assert.notEqual(flip.notification.reason, "daily_limit");
assert.equal((await rateRef.get()).get("lastSentAt").toMillis(), lastSentBefore, "상태 바뀜 알림은 쿨다운 시각을 바꾸지 않음");

// --- 하루 10회 제한: 이미 2회(키오스크·미등원) → 8회 더 보내면 11번째부터 daily_limit(기록은 저장) ---
let status = "absent";
for (let i = 0; i < 8; i++) {
  status = status === "absent" ? "present" : "absent";
  const r = await call("recordStudentArrival", { ...arrival("s5"), status });
  assert.equal(r.changed, true);
  assert.notEqual(r.notification.reason, "daily_limit", `${i + 3}번째는 보냄`);
}
status = status === "absent" ? "present" : "absent";
const limited = await call("recordStudentArrival", { ...arrival("s5"), status });
assert.equal(limited.changed, true);
assert.equal(limited.notification.reason, "daily_limit");
assert.equal((await arrivalDoc("s5")).status, status, "알림을 못 보내도 기록은 저장");
// 하루 횟수를 다 써도 기간 결석 알림(60초 쿨다운)은 따로 — 앞선 기간 결석 쿨다운이 지난 뒤 보냄
await rateRef.update({ lastSentAt: Timestamp.fromMillis(Date.now() - 120_000) });
const period3 = await call("recordStudentAbsences", {
  ...arrival("s5"), dates: [TOMORROW], reason: "general", notifyParent: true,
});
assert.notEqual(period3.notification.reason, "daily_limit");
assert.notEqual(period3.notification.reason, "cooldown");
assert.match((await lastBell("s5")).body, /사유: 기타\)$/, "일반 → 기타(★4)");
// 반 키는 따로 — 등원 키 제한과 무관
await call("recordStudentArrival", { ...arrival("s5"), status: "present" }).catch(() => null);
if ((await arrivalDoc("s5")).status !== "present") throw new Error("s5 등원 상태여야 함");
assert.notEqual((await call("recordClassAttendance", { ...klass("cA", "s5"), status: "present" })).notification.reason, "daily_limit");

// --- 예전 호출 호환(B3) ---
await as(tA);
const legacy1 = await call("sendStudentAttendanceNotification", { ...arrival("s6"), kind: "absent" });
assert.equal(legacy1.ok, true);
assert.notEqual(legacy1.reason, "unchanged");
assert.equal((await arrivalDoc("s6")).status, "absent");
assert.equal((await arrivalDoc("s6")).via, "legacy");
assert.equal((await call("sendStudentAttendanceNotification", { ...arrival("s6"), kind: "absent" })).reason, "unchanged");
const legacy2 = await call("sendStudentAttendanceNotification", { ...arrival("s6"), kind: "present" });
assert.notEqual(legacy2.reason, "unchanged");
assert.match((await lastBell("s6")).body, /^S6 학생이 안전하게 등원하였습니다\./);
assert.equal((await call("sendStudentAttendanceNotification", { ...arrival("s6"), kind: "present" })).reason, "unchanged");
await assert.rejects(
  call("sendStudentAttendanceNotification", { ...arrival("s6"), kind: "absent" }),
  /이미 등원한 학생입니다/,
);
assert.equal((await arrivalDoc("s6")).status, "present");

// --- 월정액 결석 차감 회귀 + 차감 잠금(★8·B2) ---
await as(owner);
await call("recordStudentAbsences", { ...arrival("s7"), dates: [TODAY], reason: "illness", note: "독감" });
const ded = await call("applyAbsenceDeduction", { ...arrival("s7"), period: PERIOD, dates: [TODAY], perDayAmount: 5000 });
assert.equal(ded.ok, true);
const inv = (await db.doc(`academies/${A}/students/s7/tuitionInvoices/${PERIOD}`).get()).data();
const adj = inv.adjustments.find((x) => x.source === "absence");
assert.equal(adj.amount, -5000);
assert.deepEqual(adj.absenceDates, [TODAY]);
assert.equal((await arrivalDoc("s7")).billedInvoicePeriod, PERIOD);
await assert.rejects(call("recordStudentArrival", { ...arrival("s7"), status: "present" }), /결석 차감에 반영되어 있어 변경할 수 없습니다/);
assert.equal((await call("recordStudentArrival", { ...arrival("s7"), status: "absent" })).changed, false, "같은 상태는 그대로");
await assert.rejects(call("deleteStudentAttendanceRecord", { ...arrival("s7"), date: TODAY }), /결석 차감에 반영/);
const kBilled = await call("submitKioskCheckIn", arrival("s7"));
assert.equal(kBilled.alreadyArrived, false);
assert.match((await lastBell("s7")).body, /^S7 학생이 안전하게 등원하였습니다\./, "키오스크는 알림을 보냄");
const s7rec = await arrivalDoc("s7");
assert.equal(s7rec.status, "absent", "키오스크도 잠긴 기록은 그대로");
assert.equal(s7rec.reason, "illness");
await assert.rejects(
  call("recordClassAttendance", { ...klass("cA", "s7"), status: "present" }),
  /청구서 결석 차감에 반영된 날입니다\. 청구서에서 차감을 삭제한 뒤 등원 처리해 주세요\./,
);
await call("removeTuitionInvoiceAdjustment", { ...arrival("s7"), period: PERIOD, adjustmentId: adj.id });
assert.equal((await arrivalDoc("s7")).billedInvoicePeriod, undefined, "조정 삭제 → 잠금 해제");
assert.equal((await call("recordStudentArrival", { ...arrival("s7"), status: "present" })).changed, true);
assert.equal((await call("recordClassAttendance", { ...klass("cA", "s7"), status: "present" })).changed, true);

// --- 알림 기록 응답(★7-③) ---
const log = await call("listAttendanceNotifications", { academyId: A, limit: 100 });
const classItem = log.items.find((x) => x.studentId === "s1" && x.context === "class");
assert.equal(classItem.className, "A반");
assert.equal(classItem.classId, "cA");
assert.ok(log.items.some((x) => x.context === "arrival" && x.classId === null));

// --- saveClass 요일당 1칸 ---
await assert.rejects(
  call("saveClass", {
    academyId: A, name: "x",
    schedule: [{ weekday: 1, start: "15:00", end: "16:00" }, { weekday: 1, start: "18:00", end: "19:00" }],
  }),
  /같은 요일에 수업 시간을 두 번/,
);
await assert.rejects(
  call("saveClass", {
    academyId: A, name: "x",
    schedule: [1, 2, 3, 4, 5, 6, 7, 1].map((weekday, i) => ({ weekday, start: `0${i}:00`.slice(-5), end: "23:00" })),
  }),
  /최대 7개/,
);
const renamed = await call("saveClass", { academyId: A, classId: "cLegacy", name: "두번반(이름만)" });
assert.equal(renamed.ok, true);
const legacyAfter = (await db.doc(`academies/${A}/classes/cLegacy`).get()).data();
assert.equal(legacyAfter.name, "두번반(이름만)");
assert.equal(legacyAfter.schedule.length, 2, "수업 시간을 보내지 않은 수정은 예전 칸 그대로");

// --- 학생 삭제 → 반 출결도 삭제(B6) ---
assert.ok((await db.collection(`academies/${A}/attendance`).where("studentId", "==", "s8").get()).size >= 1);
await call("deleteAcademyStudent", arrival("s8"));
assert.equal((await db.collection(`academies/${A}/attendance`).where("studentId", "==", "s8").get()).size, 0);
assert.ok((await db.collection(`academies/${A}/attendance`).where("studentId", "==", "s1").get()).size >= 1, "다른 학생 기록은 그대로");

await signOut(auth);
console.log("SMOKE OK attendance");
process.exit(0);
