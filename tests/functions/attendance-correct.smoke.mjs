/**
 * 3-A 지난 날짜 정정·사유와 코멘트·일괄 처리 스모크 — `npm run test:functions` (Auth·Firestore·Functions 에뮬레이터)
 * correctStudentArrival·correctClassAttendance·updateAttendanceDetails·recordAttendanceBatch:
 * 권한(원장·출결 직원 ✓ / 담당 선생님·반 관리만·청구서만 직원·무관 ✗, 트랜잭션 안 권한 재확인), 오늘·미래 거부·날짜 제한 없음,
 * 알림·벨·알림 기록 0건 + 하루 10회 키 안 건드림, 정정 이력, 등원 시각(★2·B4·B3), 불변식 2개, 반 원생 아님, 종강·삭제된 반,
 * sessionDeduction, 차감 잠금(★4), 사유·코멘트 두 층(기록 유지), 일괄(오늘 알림·지난 날짜 무알림·막힌 줄·모드 불일치 B1·51명),
 * 기존 기록 삭제·기간 결석 덮어쓰기 이력(★5), A11(반에서 빠진 선생님), 학생 삭제 cascade(B6), 예전 함수 삭제를 확인한다.
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
const A = "o9_attx";

const SEOUL_WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const now = new Date();
const TODAY = now.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
const shift = (days) =>
  new Date(Date.parse(`${TODAY}T12:00:00+09:00`) + days * 86400000).toLocaleDateString("en-CA", {
    timeZone: "Asia/Seoul",
  });
const weekdayOf = (date) =>
  SEOUL_WEEKDAY[
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(
      new Date(`${date}T12:00:00+09:00`),
    )
  ];
const Y1 = shift(-1);
const Y2 = shift(-2);
const TOMORROW = shift(1);
const OLD = "2025-03-03";
const WD_TODAY = weekdayOf(TODAY);
const WD_Y1 = weekdayOf(Y1);

const mkUser = (email) => adminAuth().createUser({ email, password: "pass1234", emailVerified: true });
const owner = await mkUser("owner-attx@t.dev");
const attStaff = await mkUser("attx-staff@t.dev");
const billingStaff = await mkUser("attx-bill@t.dev");
const classesOnly = await mkUser("attx-cls@t.dev");
const tA = await mkUser("attx-ta@t.dev");
const stranger = await mkUser("attx-stranger@t.dev");

await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "정정 학원", status: "active" });
const staff = (u, permissions, name) =>
  db.doc(`academies/${A}/staff/${u.uid}`).set({
    authUid: u.uid, displayName: name, status: "active", roleId: "x", permissions, employmentStatus: "employed",
  });
await staff(attStaff, ["lessons.attendance"], "출결 직원");
await staff(billingStaff, ["billing.invoices"], "청구 직원");
await staff(classesOnly, ["operations.classes"], "반 직원");
await staff(tA, [], "A선생");
await db.doc(`academies/${A}/parents/p9x`).set({ authUid: "p9x", displayName: "보호자", status: "active" });

const cls = (name, extra) => ({ name, status: "active", sortOrder: 0, roomId: null, capacity: null, ...extra });
await db.doc(`academies/${A}/classes/cA`).set(
  cls("A반", {
    schedule: [
      { weekday: WD_TODAY, start: "15:00", end: "17:00" },
      ...(WD_Y1 !== WD_TODAY ? [{ weekday: WD_Y1, start: "16:00", end: "18:00" }] : []),
    ],
    teacherUids: [tA.uid],
  }),
);
await db.doc(`academies/${A}/classes/cB`).set(cls("B반", { schedule: [], teacherUids: [] }));
await db.doc(`academies/${A}/classes/cEnd`).set(cls("끝난반", { status: "ended", schedule: [], teacherUids: [] }));

const student = (id, extra) =>
  db.doc(`academies/${A}/students/${id}`).set({
    name: id.toUpperCase(), status: "enrolled", grade: "e3", gradeYear: 2026, guardians: [], guardianPhones: [],
    parentUids: ["p9x"], classIds: ["cA"], teacherUids: [tA.uid], ...extra,
  });
for (const id of ["s1", "s2", "s3", "s5", "s6", "s7", "s8", "s9", "s11", "s12", "s13"]) await student(id, {});
await student("s4", { classIds: ["cB"], teacherUids: [] });
await student("s10", { status: "on_leave" });

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
const fixArrival = (sid, date, status, extra = {}) =>
  call("correctStudentArrival", { academyId: A, studentId: sid, date, status, ...extra });
const fixClass = (classId, sid, date, status, extra = {}) =>
  call("correctClassAttendance", { academyId: A, classId, studentId: sid, date, status, ...extra });
const details = (data) => call("updateAttendanceDetails", { academyId: A, ...data });
const batch = (data) => call("recordAttendanceBatch", { academyId: A, classId: "cA", ...data });
const arrivalRef = (sid, date) => db.doc(`academies/${A}/students/${sid}/attendanceRecords/${date}`);
const arrivalDoc = async (sid, date) => (await arrivalRef(sid, date).get()).data();
const classRef = (classId, sid, date) => db.doc(`academies/${A}/attendance/${date}_${classId}_${sid}`);
const classDoc = async (classId, sid, date) => (await classRef(classId, sid, date).get()).data();
const corrections = async (sid) =>
  (await db.collection(`academies/${A}/attendanceCorrections`).where("studentId", "==", sid).get()).docs
    .map((d) => d.data())
    .sort((a, b) => a.at.toMillis() - b.at.toMillis());
const notifCount = async (filter = {}) => {
  let q = db.collection(`academies/${A}/attendanceNotifications`);
  for (const [k, v] of Object.entries(filter)) q = q.where(k, "==", v);
  return (await q.get()).size;
};
const bellCount = async () => (await db.collection("users/p9x/dashboardBellItems").get()).size;
const seoulMs = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+09:00`);

// --- 권한: 담당 선생님·반 관리만·청구서만 직원·무관 ✗ ---
for (const u of [tA, classesOnly, billingStaff]) {
  await as(u);
  await assert.rejects(fixArrival("s1", Y1, "present"), /지난 날짜 출결은 원장이나 출결 권한이 있는 직원만 정정할 수 있습니다/);
  await assert.rejects(fixClass("cA", "s1", Y1, "present"), /지난 날짜 출결은 원장이나/);
  await assert.rejects(details({ layer: "arrival", studentId: "s1", date: Y1, note: "x" }), /사유·메모는 원장이나/);
}
await as(stranger);
await assert.rejects(fixArrival("s1", Y1, "present"), /권한/);

// --- 날짜: 오늘·미래 거부, 형식 오류, 아주 오래된 날짜 허용(제한 없음) ---
await as(owner);
await assert.rejects(fixArrival("s1", TODAY, "present"), /지난 날짜만 정정할 수 있습니다\. 오늘 기록은 출결 버튼으로 처리해 주세요\./);
await assert.rejects(fixClass("cA", "s1", TOMORROW, "present"), /앞으로의 날짜는 정정할 수 없습니다\./);
await assert.rejects(fixArrival("s1", "2026-02-30", "present"), /요청이 올바르지 않습니다/);
await assert.rejects(fixArrival("s1", Y1, "late"), /요청이 올바르지 않습니다/);
await assert.rejects(fixArrival("s1", Y1, "present", { reason: "illness" }), /사유는 미등원·결석 기록에만/);
await assert.rejects(fixArrival("s1", Y1, "absent", { arrivedAtTime: "14:00" }), /요청이 올바르지 않습니다/);
await assert.rejects(fixArrival("s1", Y1, "present", { arrivedAtTime: "25:00" }), /요청이 올바르지 않습니다/);
await assert.rejects(fixArrival("s1", Y1, "present", { via: "kiosk" }), /경로/);
assert.equal((await fixArrival("s1", OLD, "present")).changed, true);

// --- 등원 기록 만들기(원장, 미등원 질병) → 알림 0·정정 이력 ---
const notifsBefore = await notifCount();
const bellsBefore = await bellCount();
const r1 = await fixArrival("s1", Y1, "absent", { reason: "illness" });
assert.deepEqual(r1, { ok: true, changed: true, status: "absent" });
let d1 = await arrivalDoc("s1", Y1);
assert.equal(d1.status, "absent");
assert.equal(d1.reason, "illness");
assert.equal(d1.academyId, A);
assert.equal(d1.studentId, "s1");
assert.equal(d1.date, Y1);
assert.equal(d1.recordedByRole, "owner");
assert.equal(d1.correctedByUid, owner.uid);
assert.ok(d1.correctedAt);
assert.equal(d1.via, "attendance_screen");
const c1 = (await corrections("s1")).filter((c) => c.date === Y1);
assert.equal(c1.length, 1);
assert.equal(c1[0].layer, "arrival");
assert.equal(c1[0].action, "create");
assert.equal(c1[0].before, null);
assert.equal(c1[0].after.status, "absent");
assert.equal(c1[0].after.reason, "illness");
assert.equal(c1[0].byRole, "owner");
assert.equal(c1[0].byName, "원장");
assert.equal(c1[0].studentName, "S1");
// 같은 내용 → changed:false, 이력 없음
assert.equal((await fixArrival("s1", Y1, "absent")).changed, false, "사유 없이 같은 미등원 = 이전 사유 유지");
assert.equal((await corrections("s1")).filter((c) => c.date === Y1).length, 1);

// --- 등원 시각(★2·B4·B3) — 출결 직원 ---
await as(attStaff);
await fixArrival("s2", Y1, "present", { arrivedAtTime: "14:30" });
let d2 = await arrivalDoc("s2", Y1);
assert.equal(d2.arrivedAt.toMillis(), seoulMs(Y1, "14:30"));
assert.equal(d2.arrivedAtManual, true);
assert.equal(d2.recordedByRole, "teacher");
assert.equal((await fixArrival("s2", Y1, "present")).changed, false, "시각을 안 보내면 그대로");
assert.equal((await fixArrival("s2", Y1, "present", { arrivedAtTime: "14:30" })).changed, false);
assert.equal((await fixArrival("s2", Y1, "present", { arrivedAtTime: "15:05" })).changed, true, "B4 시각만 다르면 고침");
assert.equal((await arrivalDoc("s2", Y1)).arrivedAt.toMillis(), seoulMs(Y1, "15:05"));
let c2 = await corrections("s2");
assert.equal(c2.at(-1).action, "update");
assert.equal(c2.at(-1).before.arrivedAt.toMillis(), seoulMs(Y1, "14:30"));
assert.equal(c2.at(-1).after.arrivedAt.toMillis(), seoulMs(Y1, "15:05"));
assert.equal(c2.at(-1).byRole, "staff");
assert.equal(c2.at(-1).byName, "출결 직원");
await fixArrival("s2", Y1, "present", { arrivedAtTime: null });
d2 = await arrivalDoc("s2", Y1);
assert.equal(d2.arrivedAt, undefined, "시각 지움");
assert.equal(d2.arrivedAtManual, undefined);
await fixArrival("s2", Y1, "present", { arrivedAtTime: "13:00" });
await fixArrival("s2", Y1, "absent");
d2 = await arrivalDoc("s2", Y1);
assert.equal(d2.reason, "general", "★3 미등원 기본 기타");
assert.equal(d2.arrivedAt, undefined, "B3 미등원이면 시각 지움");
assert.equal(d2.arrivedAtManual, undefined);
await fixArrival("s2", Y1, null);
assert.equal(await arrivalDoc("s2", Y1), undefined, "지우기");
assert.equal((await corrections("s2")).at(-1).action, "delete");
assert.equal((await fixArrival("s2", Y1, null)).changed, false, "지울 기록 없음");

// --- 불변식: 반 출결은 그날 등원일 때만 ---
await assert.rejects(fixClass("cA", "s3", Y1, "present"), /등원 기록이 없어 수업 출결을 기록할 수 없습니다\. 등원 기록을 먼저 정정해 주세요\./);
await fixArrival("s3", Y1, "absent");
await assert.rejects(fixClass("cA", "s3", Y1, "present"), /미등원으로 기록되어 있어 수업 출결을 기록할 수 없습니다/);
await fixArrival("s3", Y1, "present");
assert.equal((await fixClass("cA", "s3", Y1, "present")).changed, true);
const k3 = await classDoc("cA", "s3", Y1);
assert.equal(k3.status, "present");
assert.equal(k3.className, "A반");
assert.deepEqual(k3.slots, [WD_Y1 !== WD_TODAY ? { start: "16:00", end: "18:00" } : { start: "15:00", end: "17:00" }], "★11 그 요일 현재 시간표");
assert.equal(k3.markedByRole, "teacher");
assert.ok(k3.correctedAt);
// 반 출결이 있는 날은 등원 → 미등원·삭제 거부
await assert.rejects(fixArrival("s3", Y1, "absent"), /수업 출결 기록이 1건 있어 미등원으로 바꿀 수 없습니다\. 수업 출결을 먼저 정정해 주세요\./);
await assert.rejects(fixArrival("s3", Y1, null), /수업 출결 기록이 1건 있어 등원 기록을 지울 수 없습니다/);
// 등원 시각 고치기는 반 출결이 있어도 허용
assert.equal((await fixArrival("s3", Y1, "present", { arrivedAtTime: "15:50" })).changed, true);
// 수업 없는 요일(Y2에 A반 수업 없음일 수도)·지난 날짜에도 만들 수 있음 — 시간표 칸이 없으면 slots 빈 칸
await fixArrival("s3", OLD, "present");
await fixClass("cA", "s3", OLD, "absent");
const kOld = await classDoc("cA", "s3", OLD);
assert.equal(kOld.reason, "general", "결석 기본 사유 기타");
assert.ok(Array.isArray(kOld.slots));

// --- 반 원생 아님: 새 기록 거부, 그날 기록이 있으면 바꾸기 허용 ---
await fixArrival("s4", Y1, "present");
await assert.rejects(fixClass("cA", "s4", Y1, "present"), /이 반 원생이 아니어서 .+ 수업 출결을 새로 기록할 수 없습니다\./);
await classRef("cA", "s4", Y1).set({ academyId: A, date: Y1, classId: "cA", studentId: "s4", status: "present", className: "A반", slots: [] });
assert.equal((await fixClass("cA", "s4", Y1, "absent")).changed, true);
await assert.rejects(fixClass("nope", "s4", Y1, "present"), /반을 찾을 수 없습니다/);

// --- 종강·삭제된 반에 남은 기록 고치기(재원·종강·수업 보지 않음) ---
await as(owner);
await fixArrival("s5", Y1, "present");
await classRef("cEnd", "s5", Y1).set({ academyId: A, date: Y1, classId: "cEnd", studentId: "s5", status: "present", className: "끝난반", slots: [] });
await classRef("cGone", "s5", Y1).set({ academyId: A, date: Y1, classId: "cGone", studentId: "s5", status: "present", className: "없어진반", slots: [{ start: "10:00", end: "11:00" }] });
assert.equal((await fixClass("cEnd", "s5", Y1, "absent")).changed, true);
assert.equal((await fixClass("cGone", "s5", Y1, "absent")).changed, true);
const gone = await classDoc("cGone", "s5", Y1);
assert.equal(gone.className, "없어진반", "반 문서가 없으면 스냅샷 이름");
assert.deepEqual(gone.slots, [{ start: "10:00", end: "11:00" }], "기존 slots 유지");
assert.equal((await fixClass("cGone", "s5", Y1, null)).changed, true);
assert.equal(await classDoc("cGone", "s5", Y1), undefined);
await assert.rejects(fixClass("cGone", "s1", Y1, "present"), /반을 찾을 수 없습니다/);
// 휴원 원생도 지난 날짜 정정 가능
assert.equal((await fixArrival("s10", Y1, "present")).changed, true);

// --- sessionDeduction 거부(바꾸기·지우기·사유) ---
await classRef("cEnd", "s5", Y1).update({ sessionDeduction: { ledgerId: "l1", at: Timestamp.now() } });
await assert.rejects(fixClass("cEnd", "s5", Y1, "present"), /회차 차감이 연결된 기록이라 정정할 수 없습니다/);
await assert.rejects(fixClass("cEnd", "s5", Y1, null), /회차 차감이 연결된 기록이라/);
await assert.rejects(details({ layer: "class", classId: "cEnd", studentId: "s5", date: Y1, reason: "illness" }), /회차 차감/);
assert.equal((await details({ layer: "class", classId: "cEnd", studentId: "s5", date: Y1, note: "보강 예정" })).changed, true, "코멘트는 허용");

// --- 차감 잠금(★4): 상태·삭제·사유 거부, 메모 허용 ---
await arrivalRef("s6", Y1).set({
  date: Y1, status: "absent", reason: "illness", academyId: A, studentId: "s6",
  billedInvoicePeriod: Y1.slice(0, 7), billedAdjustmentId: "adj1",
});
await assert.rejects(fixArrival("s6", Y1, "present"), /결석 차감에 반영되어 있어 변경할 수 없습니다/);
await assert.rejects(fixArrival("s6", Y1, null), /결석 차감에 반영되어/);
await assert.rejects(fixArrival("s6", Y1, "absent", { reason: "general" }), /결석 차감에 반영되어/);
await assert.rejects(details({ layer: "arrival", studentId: "s6", date: Y1, reason: "general" }), /결석 차감에 반영되어/);
assert.equal((await details({ layer: "arrival", studentId: "s6", date: Y1, note: "독감 확진" })).changed, true);
const d6 = await arrivalDoc("s6", Y1);
assert.equal(d6.note, "독감 확진");
assert.equal(d6.reason, "illness");
assert.equal(d6.billedInvoicePeriod, Y1.slice(0, 7), "잠금 그대로");

// --- 사유·코멘트 두 층(기록 유지, 알림 없음) ---
await as(attStaff);
const det1 = await details({ layer: "arrival", studentId: "s1", date: Y1, reason: "academy", note: "  학원 공사  " });
assert.equal(det1.changed, true);
d1 = await arrivalDoc("s1", Y1);
assert.equal(d1.status, "absent", "기록 유지");
assert.equal(d1.reason, "academy");
assert.equal(d1.note, "학원 공사", "앞뒤 공백 정리");
const cDetail = (await corrections("s1")).at(-1);
assert.equal(cDetail.action, "detail");
assert.equal(cDetail.before.reason, "illness");
assert.equal(cDetail.after.reason, "academy");
assert.equal(cDetail.after.note, "학원 공사");
assert.equal((await details({ layer: "arrival", studentId: "s1", date: Y1, reason: "academy" })).changed, false);
await details({ layer: "arrival", studentId: "s1", date: Y1, note: "" });
assert.equal((await arrivalDoc("s1", Y1)).note, undefined, "빈 메모 = 지움");
assert.equal((await details({ layer: "arrival", studentId: "s1", date: Y1, note: "x".repeat(250) })).changed, true);
assert.equal((await arrivalDoc("s1", Y1)).note.length, 200);
await assert.rejects(details({ layer: "arrival", studentId: "s3", date: Y1, reason: "illness" }), /사유는 미등원·결석 기록에만/);
await assert.rejects(details({ layer: "arrival", studentId: "s9", date: Y2, note: "x" }), /출결 기록을 찾을 수 없습니다/);
await assert.rejects(details({ layer: "arrival", studentId: "s1", date: Y1 }), /요청이 올바르지 않습니다/);
// 반 층: 출석에 코멘트 → 결석으로 바꿔도 코멘트 유지, 사유 기본 기타 → 질병으로
await details({ layer: "class", classId: "cA", studentId: "s3", date: Y1, note: "숙제 안 해 옴" });
await assert.rejects(details({ layer: "class", classId: "cA", studentId: "s3", date: Y1, reason: "illness" }), /사유는 미등원·결석/);
await fixClass("cA", "s3", Y1, "absent");
let k3b = await classDoc("cA", "s3", Y1);
assert.equal(k3b.comment, "숙제 안 해 옴", "★3 코멘트 유지");
assert.equal(k3b.reason, "general");
await details({ layer: "class", classId: "cA", studentId: "s3", date: Y1, reason: "illness" });
assert.equal((await classDoc("cA", "s3", Y1)).reason, "illness");
assert.equal((await fixClass("cA", "s3", Y1, "absent")).changed, false, "사유 없이 같은 결석 = 이전 사유 유지");
await fixClass("cA", "s3", Y1, "present");
k3b = await classDoc("cA", "s3", Y1);
assert.equal(k3b.reason, undefined, "출석이면 사유 지움");
assert.equal(k3b.comment, "숙제 안 해 옴");
// 오늘 기록의 사유·메모도 알림 없이(기록은 오늘 함수로)
await call("recordStudentArrival", { academyId: A, studentId: "s7", status: "absent", date: TODAY });
const s7Notifs = await notifCount({ studentId: "s7" });
await details({ layer: "arrival", studentId: "s7", date: TODAY, reason: "illness", note: "병원" });
assert.equal((await arrivalDoc("s7", TODAY)).reason, "illness");
assert.equal(await notifCount({ studentId: "s7" }), s7Notifs, "사유 바꾸기는 알림 없음");
// 직원 권한이 빠지면 트랜잭션 안에서도 거부
await db.doc(`academies/${A}/staff/${attStaff.uid}`).update({ permissions: [] });
await assert.rejects(fixArrival("s9", Y1, "present"), /지난 날짜 출결은 원장이나/);
await db.doc(`academies/${A}/staff/${attStaff.uid}`).update({ permissions: ["lessons.attendance"] });

// --- 지난 날짜 정정은 알림·벨·알림 기록 0건, 하루 10회 키도 건드리지 않음 ---
assert.equal(await notifCount({ date: Y1 }), 0);
assert.equal(await notifCount({ date: OLD }), 0);
assert.equal(await notifCount() - notifsBefore, 1, "s7 오늘 미등원 1건만");
assert.equal(await bellCount() - bellsBefore, 1);
for (const sid of ["s1", "s2", "s3", "s4", "s5"]) {
  assert.equal((await db.doc(`_pushRateLimits/attendance_${A}_${sid}`).get()).exists, false, sid);
}

// --- 일괄: 모드 불일치(B1)·권한·인원·미래 ---
await as(owner);
await assert.rejects(batch({ date: TODAY, mode: "past", action: "arrive", studentIds: ["s8"] }), /날짜가 바뀌어 처리 방식이 달라졌습니다/);
await assert.rejects(batch({ date: Y1, mode: "today", action: "arrive", studentIds: ["s8"] }), /날짜가 바뀌어/);
await assert.rejects(batch({ date: TOMORROW, mode: "today", action: "arrive", studentIds: ["s8"] }), /앞으로의 날짜/);
await assert.rejects(
  batch({ date: TODAY, mode: "today", action: "arrive", studentIds: Array.from({ length: 51 }, (_, i) => `x${i}`) }),
  /1~50명/,
);
await assert.rejects(batch({ date: TODAY, mode: "today", action: "arrive", studentIds: ["s8", "s8"] }), /요청이 올바르지 않습니다/);
await assert.rejects(batch({ date: TODAY, mode: "today", action: "leave", studentIds: ["s8"] }), /요청이 올바르지 않습니다/);
await as(tA);
await assert.rejects(batch({ date: TODAY, mode: "today", action: "arrive", studentIds: ["s8"] }), /일괄 처리는 원장이나 출결 권한/);

// --- 일괄 오늘: 원생마다 기존 로직 + 알림, 막힌 줄은 건너뜀 ---
await as(owner);
const bt1 = await batch({ date: TODAY, mode: "today", action: "arrive", studentIds: ["s8", "s9", "s10"] });
assert.equal(bt1.mode, "today");
assert.deepEqual(bt1.results.map((r) => r.result), ["changed", "changed", "blocked"]);
assert.match(bt1.results[2].message, /재원 중인 원생만/);
assert.deepEqual(bt1.counts, { changed: 2, unchanged: 0, blocked: 1 });
assert.equal(await notifCount({ studentId: "s8", date: TODAY }), 1, "오늘 일괄은 알림");
assert.equal((await arrivalDoc("s8", TODAY)).via, "attendance_batch");
const bt2 = await batch({ date: TODAY, mode: "today", action: "class_present", studentIds: ["s8", "s11", "s8x"] });
assert.deepEqual(bt2.results.map((r) => r.result), ["changed", "blocked", "blocked"]);
assert.match(bt2.results[1].message, /아직 등원 처리되지 않았습니다/);
assert.match(bt2.results[2].message, /학생을 찾을 수 없습니다/);
assert.equal((await classDoc("cA", "s8", TODAY)).status, "present");
assert.ok(bt2.results[0].notification);
const bt3 = await batch({ date: TODAY, mode: "today", action: "arrive", studentIds: ["s8"] });
assert.equal(bt3.results[0].result, "unchanged");

// --- 일괄 지난 날짜: 정정 로직, 알림 없음, 정정 이력 via attendance_batch ---
const nBefore = await notifCount();
const bp1 = await batch({ date: Y1, mode: "past", action: "arrive", studentIds: ["s8", "s9"] });
assert.equal(bp1.mode, "past");
assert.deepEqual(bp1.counts, { changed: 2, unchanged: 0, blocked: 0 });
assert.equal(bp1.results[0].notification, undefined);
const bp2 = await batch({ date: Y1, mode: "past", action: "class_absent", studentIds: ["s8", "s4", "s11"] });
assert.deepEqual(
  bp2.results.map((r) => r.result),
  ["changed", "unchanged", "blocked"],
  "s4는 반 원생이 아니지만 그날 A반 기록(이미 결석)이 있어 막히지 않음",
);
assert.match(bp2.results[2].message, /등원 기록이 없어/);
assert.equal((await classDoc("cA", "s8", Y1)).reason, "general");
assert.equal(await notifCount(), nBefore, "지난 날짜 일괄은 알림 없음");
assert.equal((await corrections("s8")).at(-1).via, "attendance_batch");

// --- ★5 기존 함수 이력: 기간 결석 덮어쓰기(지난 날짜·내용 다를 때만)·기록 삭제 ---
const c9 = (await corrections("s9")).length;
await call("recordStudentAbsences", { academyId: A, studentId: "s9", dates: [Y1], reason: "illness", note: "감기" });
let c9list = await corrections("s9");
assert.equal(c9list.length, c9 + 1);
assert.equal(c9list.at(-1).before.status, "present");
assert.equal(c9list.at(-1).after.reason, "illness");
assert.equal(c9list.at(-1).via, "student_detail");
await call("recordStudentAbsences", { academyId: A, studentId: "s9", dates: [Y1], reason: "illness", note: "감기" });
assert.equal((await corrections("s9")).length, c9 + 1, "같은 내용이면 이력 없음");
// 빈 메모로 다시 저장해도 기존 메모 유지(merge), 정정 표시 등 다른 필드도 유지, 이력 after.note = 실제 남는 값
await arrivalRef("s9", Y1).update({ correctedByUid: "keep-me" });
await call("recordStudentAbsences", { academyId: A, studentId: "s9", dates: [Y1], reason: "academy" });
const d9 = await arrivalDoc("s9", Y1);
assert.equal(d9.note, "감기", "빈 메모 = 기존 메모 유지");
assert.equal(d9.reason, "academy");
assert.equal(d9.correctedByUid, "keep-me", "다른 필드 유지");
assert.equal(d9.arrivedAt, undefined, "미등원이면 등원 시각 없음");
assert.equal((await corrections("s9")).at(-1).after.note, "감기");
assert.equal((await corrections("s9")).length, c9 + 2);
await call("recordStudentAbsences", { academyId: A, studentId: "s9", dates: [Y2], reason: "general" });
assert.equal((await corrections("s9")).length, c9 + 2, "기존 기록이 없던 날은 이력 없음");
await call("deleteStudentAttendanceRecord", { academyId: A, studentId: "s9", date: Y2 });
c9list = await corrections("s9");
assert.equal(c9list.at(-1).action, "delete");
assert.equal(c9list.at(-1).date, Y2);

// --- A11: 반에서 빠진 선생님은 트랜잭션 안 반 문서로 거부 ---
await as(tA);
await call("recordStudentArrival", { academyId: A, studentId: "s12", status: "present", date: TODAY });
assert.equal(
  (await call("recordClassAttendance", { academyId: A, classId: "cA", studentId: "s12", status: "present", date: TODAY })).changed,
  true,
);
await db.doc(`academies/${A}/classes/cA`).update({ teacherUids: [] });
await assert.rejects(
  call("recordClassAttendance", { academyId: A, classId: "cA", studentId: "s12", status: "absent", date: TODAY }),
  /이 반 출결을 기록할 권한이 없습니다/,
);
await db.doc(`academies/${A}/classes/cA`).update({ teacherUids: [tA.uid] });

// --- 그날 삭제된 반에 남은 오늘 기록: 원장·출결 권한만 취소(선생님은 반 문서가 없어 거부) ---
await as(owner);
await db.doc(`academies/${A}/classes/cTmp`).set(
  cls("임시반", { schedule: [{ weekday: WD_TODAY, start: "20:00", end: "21:00" }], teacherUids: [tA.uid] }),
);
await db.doc(`academies/${A}/students/s13`).update({ classIds: ["cA", "cTmp"] });
await call("recordStudentArrival", { academyId: A, studentId: "s13", status: "present", date: TODAY });
await call("recordClassAttendance", { academyId: A, classId: "cTmp", studentId: "s13", status: "present", date: TODAY });
await db.doc(`academies/${A}/classes/cTmp`).delete();
await as(tA);
await assert.rejects(
  call("cancelClassAttendance", { academyId: A, classId: "cTmp", studentId: "s13", date: TODAY }),
  /반을 찾을 수 없습니다/,
);
await as(owner);
const cTmp = await call("cancelClassAttendance", { academyId: A, classId: "cTmp", studentId: "s13", date: TODAY, via: "attendance_screen" });
assert.equal(cTmp.changed, true);
assert.equal(await classDoc("cTmp", "s13", TODAY), undefined);
await assert.rejects(
  call("cancelClassAttendance", { academyId: A, classId: "cTmp", studentId: "s13", date: TODAY }),
  /반을 찾을 수 없습니다/,
  "반도 기록도 없으면 not-found",
);

// --- 학생 삭제 cascade(B6): 정정 이력도 삭제 ---
await as(owner);
assert.ok((await corrections("s2")).length > 0);
await call("deleteAcademyStudent", { academyId: A, studentId: "s2" });
assert.equal((await corrections("s2")).length, 0);
assert.ok((await corrections("s1")).length > 0, "다른 학생 이력은 그대로");

// --- 예전 호환 함수 삭제(A12) ---
await assert.rejects(
  call("sendStudentAttendanceNotification", { academyId: A, studentId: "s1", kind: "present" }),
  (e) => /not-found|internal|unavailable/.test(String(e.code)),
);

await signOut(auth);
console.log("SMOKE OK attendance-correct");
process.exit(0);
