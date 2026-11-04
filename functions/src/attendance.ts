import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  sendStudentAttendanceNotificationCore,
  type AttendanceNotifyOutcome,
  type AttendanceSender,
} from "./attendance-send-core";
import { actorHasPermission, resolveAcademyActor } from "./lib/academy-access";
import {
  arrivalPushBody,
  arrivalTransition,
  classAttendanceBlock,
  classAttendanceDocId,
  classPushBody,
  CLASS_ATTENDANCE_BLOCK_MESSAGES,
  seoulDateString,
  seoulWeekday,
  slotsOnWeekday,
  type ArrivalSnapshot,
  type AttendanceStatus,
} from "./lib/attendance-rules";
import { isClassStatus } from "./lib/class-teachers";
import { readSchedule } from "./lib/class-schedule";
import { readUidList } from "./lib/parent-recipients";
import { isActiveStudent } from "./lib/student-profile";

/**
 * 2-I 등원·반 출결 — 결정 `docs/stage2-handoff/2-I-decisions.md`, 계획 `2-I-plan.md`.
 * - 등원 기록: `students/{sid}/attendanceRecords/{date}`(present=등원, absent=미등원, 원비 차감 근거)
 * - 반 출결: `attendance/{date}_{classId}_{studentId}`(present=출석, absent=결석)
 * 알림은 상태가 실제로 바뀔 때만 보낸다(같은 상태 다시 누르기 = 기록·알림 그대로).
 */

/** 기록용 경로 — 권한·조건 판단에는 쓰지 않는다 */
const ARRIVAL_VIA = ["teacher_my_classes", "student_list", "student_detail", "class_detail"] as const;
const CLASS_VIA = ["teacher_my_classes", "class_detail"] as const;
export type AttendanceVia =
  | (typeof ARRIVAL_VIA)[number]
  | (typeof CLASS_VIA)[number]
  | "kiosk"
  | "absence_period"
  | "legacy";

function parseVia<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "string" && (allowed as readonly string[]).includes(raw)) return raw as T;
  throw new HttpsError("invalid-argument", "요청 경로가 올바르지 않습니다.");
}

function requireId(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.includes("/")) throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  return s;
}

function parseStatus(raw: unknown): AttendanceStatus {
  if (raw === "present" || raw === "absent") return raw;
  throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
}

export function arrivalRecordRef(
  db: admin.firestore.Firestore,
  academyId: string,
  studentId: string,
  date: string,
) {
  return db.doc(`academies/${academyId}/students/${studentId}/attendanceRecords/${date}`);
}

export function classAttendanceCol(db: admin.firestore.Firestore, academyId: string) {
  return db.collection(`academies/${academyId}/attendance`);
}

/** 그날(들) 반 출결 기록 수 — 등원→미등원·기간 결석·기록 삭제 판단(트랜잭션 안에서도 사용) */
export function classAttendanceOnDatesQuery(
  db: admin.firestore.Firestore,
  academyId: string,
  studentId: string,
  dates: readonly string[],
) {
  const col = classAttendanceCol(db, academyId).where("studentId", "==", studentId);
  return dates.length === 1 ? col.where("date", "==", dates[0]) : col.where("date", "in", [...dates]);
}

export function isBilledRecord(data: FirebaseFirestore.DocumentData | undefined): boolean {
  return typeof data?.billedInvoicePeriod === "string" && data.billedInvoicePeriod.length > 0;
}

function arrivalSnapshotOf(snap: FirebaseFirestore.DocumentSnapshot): ArrivalSnapshot {
  if (!snap.exists) return null;
  return { status: snap.get("status") === "absent" ? "absent" : "present", billed: isBilledRecord(snap.data()) };
}

function formatDateLabel(dateStr: string): string {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${m}월 ${d}일`;
}

export function billedLockError(dates: string[], period: string): HttpsError {
  const [, m] = period.split("-").map(Number);
  return new HttpsError(
    "failed-precondition",
    `${dates.map(formatDateLabel).join(", ")} 기록은 ${m}월 청구서 결석 차감에 반영되어 있어 변경할 수 없습니다. ` +
      "청구서에서 해당 차감을 먼저 삭제해 주세요.",
  );
}

/** 처리한 사람 → 기록자 역할(원장 = academy_dashboard, 활성 직원 = teacher_dashboard — 지금과 같음) */
function senderForActor(actor: { kind: "owner" | "staff"; uid: string }): AttendanceSender {
  return actor.kind === "owner"
    ? { role: "owner", actorUid: actor.uid, source: "academy_dashboard" }
    : { role: "teacher", actorUid: actor.uid, source: "teacher_dashboard" };
}

function studentName(data: Record<string, unknown>): string {
  return typeof data.name === "string" && data.name ? data.name : "학생";
}

type ArrivalMode = "button" | "kiosk" | "legacy";

export type ArrivalResult = {
  /** 기록 상태가 바뀌었는지 */
  changed: boolean;
  /** 차감 잠금으로 기록을 그대로 둔 키오스크 체크인(알림은 보냄, ★8) */
  billedKept: boolean;
  /** 처리 뒤(또는 그대로인) 상태 */
  status: AttendanceStatus;
};

/**
 * 등원 기록 쓰기(트랜잭션) — 버튼·키오스크·예전 호출 공용.
 * - button: 같은 상태 그대로, 차감 잠금이면 거부, 등원→미등원은 그날 반 출결 0건일 때만
 * - kiosk: 이미 등원이면 그대로, 차감 잠금이면 기록 그대로(알림은 호출한 쪽이 보냄)
 * - legacy(예전 sendStudentAttendanceNotification): button과 같되 absent는 "기록 없음 → 미등원"만(B3)
 */
export async function writeArrival(
  db: admin.firestore.Firestore,
  params: {
    academyId: string;
    studentId: string;
    status: AttendanceStatus;
    sender: AttendanceSender;
    via: AttendanceVia;
    mode: ArrivalMode;
    date: string;
  },
): Promise<ArrivalResult> {
  const { academyId, studentId, status, sender, via, mode, date } = params;
  const ref = arrivalRecordRef(db, academyId, studentId, date);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = arrivalSnapshotOf(snap);

    if (mode === "kiosk") {
      if (prev?.status === "present") return { changed: false, billedKept: false, status: "present" };
      if (prev?.billed) return { changed: false, billedKept: true, status: prev.status };
    }
    if (mode === "legacy" && status === "absent" && prev?.status === "present") {
      throw new HttpsError(
        "failed-precondition",
        "이미 등원한 학생입니다. 수업 결석은 앱을 새로고침한 뒤 반별 출석·결석 버튼으로 기록해 주세요.",
      );
    }

    // 미등원으로 바꿀 때만 그날 반 출결 수를 본다(읽기는 쓰기보다 먼저)
    const classCount =
      status === "absent" && prev?.status !== "absent"
        ? (await tx.get(classAttendanceOnDatesQuery(db, academyId, studentId, [date]))).size
        : 0;
    const transition = arrivalTransition(prev, status, classCount);
    if (transition === "unchanged") return { changed: false, billedKept: false, status };
    if (transition === "billed") throw billedLockError([date], snap.get("billedInvoicePeriod") as string);
    if (transition === "has_class_records") {
      throw new HttpsError(
        "failed-precondition",
        `오늘 수업 출결이 ${classCount}건 있어 미등원으로 바꿀 수 없습니다.`,
      );
    }

    tx.set(ref, {
      date,
      status,
      ...(status === "absent" ? { reason: "general" } : { arrivedAt: FieldValue.serverTimestamp() }),
      academyId,
      studentId,
      recordedByUid: sender.actorUid,
      recordedByRole: sender.role,
      source: sender.source,
      via,
      statusChangedAt: FieldValue.serverTimestamp(),
      createdAt: snap.exists && snap.get("createdAt") ? snap.get("createdAt") : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { changed: true, billedKept: false, status };
  });
}

/** 등원·미등원 알림(상태가 바뀐 경우·키오스크 차감 잠금) */
export function sendArrivalNotification(
  db: admin.firestore.Firestore,
  params: {
    academyId: string;
    studentId: string;
    status: AttendanceStatus;
    sender: AttendanceSender;
    studentData: Record<string, unknown>;
    date: string;
  },
): Promise<AttendanceNotifyOutcome> {
  const { academyId, studentId, status, sender, studentData, date } = params;
  return sendStudentAttendanceNotificationCore(db, {
    academyId,
    studentId,
    kind: status,
    sender,
    studentData,
    body: arrivalPushBody(studentName(studentData), status, new Date()),
    notify: { context: "arrival" },
    limit: "daily_change",
    date,
    ...(status === "absent" ? { reason: "general" } : {}),
  });
}

/**
 * 등원 처리 권한 — 원장, 출결 권한 직원, 담당 선생님(학생 teacherUids). 학생 문서가 없으면 not-found.
 * 반환: 학생 데이터와 처리한 사람
 */
export async function assertArrivalAccess(
  db: admin.firestore.Firestore,
  academyId: string,
  studentId: string,
  callerUid: string,
): Promise<{ studentData: Record<string, unknown>; sender: AttendanceSender }> {
  const studentSnap = await db.doc(`academies/${academyId}/students/${studentId}`).get();
  if (!studentSnap.exists) throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
  const studentData = studentSnap.data() as Record<string, unknown>;
  const actor = await resolveAcademyActor(db, academyId, callerUid);
  if (!actor) throw new HttpsError("permission-denied", "등원을 기록할 권한이 없습니다.");
  if (
    actor.kind === "staff" &&
    !actorHasPermission(actor, "lessons.attendance") &&
    !readUidList(studentData.teacherUids).includes(callerUid)
  ) {
    throw new HttpsError("permission-denied", "담당 반 학생만 등원 처리할 수 있습니다.");
  }
  if (!isActiveStudent(studentData)) {
    throw new HttpsError("failed-precondition", "재원 중인 원생만 출결을 기록할 수 있습니다.");
  }
  return { studentData, sender: senderForActor(actor) };
}

/** 원장·출결 권한 직원·담당 선생님 — 오늘 등원/미등원 */
export const recordStudentArrival = onCall(async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const data = (request.data ?? {}) as Record<string, unknown>;
  const academyId = requireId(data.academyId);
  const studentId = requireId(data.studentId);
  const status = parseStatus(data.status);
  const via = parseVia(data.via, ARRIVAL_VIA, "student_detail");

  const db = admin.firestore();
  const { studentData, sender } = await assertArrivalAccess(db, academyId, studentId, request.auth.uid);
  const date = seoulDateString();
  const result = await writeArrival(db, { academyId, studentId, status, sender, via, mode: "button", date });
  if (!result.changed) {
    return { ok: true as const, status, changed: false as const, notification: null };
  }
  const notification = await sendArrivalNotification(db, { academyId, studentId, status, sender, studentData, date });
  return { ok: true as const, status, changed: true as const, notification };
});

/** 원장·출결 권한 직원·그 반 선생님 — 오늘 반 출석/결석 */
export const recordClassAttendance = onCall(async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const callerUid = request.auth.uid;
  const data = (request.data ?? {}) as Record<string, unknown>;
  const academyId = requireId(data.academyId);
  const classId = requireId(data.classId);
  const studentId = requireId(data.studentId);
  const status = parseStatus(data.status);
  const via = parseVia(data.via, CLASS_VIA, "class_detail");

  const db = admin.firestore();
  const actor = await resolveAcademyActor(db, academyId, callerUid);
  if (!actor) throw new HttpsError("permission-denied", "이 반 출결을 기록할 권한이 없습니다.");
  const classRef = db.doc(`academies/${academyId}/classes/${classId}`);
  const classSnap = await classRef.get();
  if (!classSnap.exists) throw new HttpsError("not-found", "반을 찾을 수 없습니다.");
  if (
    actor.kind === "staff" &&
    !actorHasPermission(actor, "lessons.attendance") &&
    !readUidList(classSnap.get("teacherUids")).includes(callerUid)
  ) {
    throw new HttpsError("permission-denied", "이 반 출결을 기록할 권한이 없습니다.");
  }
  const sender = senderForActor(actor);

  const now = new Date();
  const date = seoulDateString(now);
  const weekday = seoulWeekday(now);
  const studentRef = db.doc(`academies/${academyId}/students/${studentId}`);
  const recordRef = classAttendanceCol(db, academyId).doc(classAttendanceDocId(date, classId, studentId));

  const outcome = await db.runTransaction(async (tx) => {
    const [studentSnap, clsSnap, arrivalSnap, recordSnap] = await tx.getAll(
      studentRef,
      classRef,
      arrivalRecordRef(db, academyId, studentId, date),
      recordRef,
    );
    if (!studentSnap!.exists) throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
    if (!clsSnap!.exists) throw new HttpsError("not-found", "반을 찾을 수 없습니다.");
    const student = studentSnap!.data() as Record<string, unknown>;
    const cls = clsSnap!.data() as Record<string, unknown>;
    const slots = slotsOnWeekday(readSchedule(cls.schedule), weekday);
    const block = classAttendanceBlock({
      studentActive: isActiveStudent(student),
      isMember: readUidList(student.classIds).includes(classId),
      classEnded: isClassStatus(cls.status) && cls.status === "ended",
      hasLessonToday: slots.length > 0,
      arrival: arrivalSnapshotOf(arrivalSnap!),
    });
    if (block) throw new HttpsError("failed-precondition", CLASS_ATTENDANCE_BLOCK_MESSAGES[block]);

    const className = typeof cls.name === "string" && cls.name ? cls.name : "반";
    const slotTimes = slots.map((s) => ({ start: s.start, end: s.end }));
    if (recordSnap!.exists && recordSnap!.get("status") === status) {
      return { changed: false as const, student, className, slotTimes };
    }
    tx.set(recordRef, {
      academyId,
      date,
      classId,
      studentId,
      status,
      className,
      slots: slotTimes,
      markedByUid: sender.actorUid,
      markedByRole: sender.role,
      source: sender.source,
      via,
      statusChangedAt: FieldValue.serverTimestamp(),
      createdAt: recordSnap!.exists && recordSnap!.get("createdAt") ? recordSnap!.get("createdAt") : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { changed: true as const, student, className, slotTimes };
  });

  if (!outcome.changed) {
    return { ok: true as const, status, changed: false as const, notification: null };
  }
  const notification = await sendStudentAttendanceNotificationCore(db, {
    academyId,
    studentId,
    kind: status,
    sender,
    studentData: outcome.student,
    body: classPushBody(studentName(outcome.student), outcome.className, status, outcome.slotTimes, new Date()),
    notify: { context: "class", classId, className: outcome.className },
    limit: "daily_change",
    date,
  });
  return { ok: true as const, status, changed: true as const, notification };
});
