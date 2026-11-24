import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  sendStudentAttendanceNotificationCore,
  type AttendanceNotifyOutcome,
  type AttendanceSender,
} from "./attendance-send-core";
import {
  arrivalRecordRef,
  arrivalSnapshotOf,
  assertArrivalAccess,
  assertRecordDate,
  DEPARTURE_FIELDS_DELETE,
  parseVia,
  requireId,
} from "./attendance";
import { assertTodayTime, requireNotFutureDate, staffRefFor } from "./attendance-correct";
import { actorHasPermission, resolveAcademyActor, type AcademyActor } from "./lib/academy-access";
import {
  assertCorrectionActor,
  correctionActorFromTx,
  departureStateOf,
  studentNameOf,
  writeCorrectionTx,
  type CorrectionVia,
} from "./lib/attendance-corrections";
import {
  ALREADY_LEFT_MESSAGE,
  CANCEL_NOT_TODAY_MESSAGE,
  CORRECTION_PERMISSION_MESSAGE,
  dateLabel,
  DEPARTURE_BEFORE_ARRIVAL_MESSAGE,
  DEPARTURE_BLOCK_MESSAGES,
  DEPARTURE_KIOSK_NO_ARRIVAL_MESSAGE,
  departureBlock,
  departureCancelPushBody,
  departurePushBody,
  isHHmm,
  seoulDateString,
  seoulDateTimeMs,
  TODAY_TIME_ONLY_MESSAGE,
} from "./lib/attendance-rules";
import { readUidList } from "./lib/parent-recipients";

/**
 * 3-B 하원 — 결정 `docs/stage3-handoff/3-B-decisions.md` B4·B5·B10, 키오스크 하원 H2·H3(`stage3-progress.md` 2장).
 * 하원은 등원 기록(날짜) 문서의 필드(`departed`·`leftAt`…, 2-I ★3)다. 반 출결·원비에는 영향이 없다(차감 잠금 날도 허용).
 * - 등원 기록이 없거나 미등원인 날은 거부(H2 — 시각을 지어내지 않음), 이미 하원이면 기록·알림 그대로(H3).
 * - 알림은 등원과 따로 하루 10회(`_pushRateLimits/departure_…`, B5).
 * - 키오스크 하원 화면·함수 연결은 3-D — 여기서는 공용 로직(`recordDepartureCore` kiosk 모드)까지.
 */

/** 직원 버튼 경로(원장 출결 화면·선생님 내 반·일괄) — 원생 카드에는 없음(B4) */
const DEPARTURE_VIA = ["teacher_my_classes", "attendance_screen"] as const;
export type DepartureVia = (typeof DEPARTURE_VIA)[number] | "attendance_batch" | "kiosk";

export type DepartureOutcome = {
  ok: true;
  changed: boolean;
  /** 이미 하원이라 그대로(H3) */
  alreadyLeft: boolean;
  message: string | null;
  notification: AttendanceNotifyOutcome | null;
};

/**
 * 하원 기록 쓰기(트랜잭션) — 버튼·키오스크 공용.
 * 등원 기록 문서를 읽고 판단한 뒤 같은 문서에 쓴다(미등원 전환도 이 문서를 읽으므로 동시에 처리돼도 순서가 맞춰진다).
 */
async function writeDeparture(
  db: admin.firestore.Firestore,
  params: { academyId: string; studentId: string; sender: AttendanceSender; via: DepartureVia; mode: "button" | "kiosk"; date: string },
): Promise<{ changed: boolean }> {
  const { academyId, studentId, sender, via, mode, date } = params;
  const ref = arrivalRecordRef(db, academyId, studentId, date);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const block = departureBlock(arrivalSnapshotOf(snap));
    if (block === "already_left") return { changed: false };
    if (block) {
      throw new HttpsError(
        "failed-precondition",
        mode === "kiosk" ? DEPARTURE_KIOSK_NO_ARRIVAL_MESSAGE : DEPARTURE_BLOCK_MESSAGES[block],
      );
    }
    tx.update(ref, {
      departed: true,
      leftAt: FieldValue.serverTimestamp(),
      leftAtManual: FieldValue.delete(),
      leftByUid: sender.actorUid,
      leftByRole: sender.role,
      leftSource: sender.source,
      leftVia: via,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { changed: true };
  });
}

/**
 * 오늘 하원 처리 — `recordStudentDeparture`·일괄·(3-D) 키오스크 공용.
 * - button: 권한 = 등원과 같음(원장·출결 권한·담당 선생님, 재원생), `date`는 화면 날짜(B1 — 오늘이 아니면 거부)
 * - kiosk: 권한·원생 확인은 키오스크 함수가 하고 `sender`·`studentData`를 넘긴다(3-D). 문구는 H2 키오스크 문구.
 */
export async function recordDepartureCore(
  db: admin.firestore.Firestore,
  params:
    | { mode: "button"; academyId: string; studentId: string; via: DepartureVia; callerUid: string; date?: unknown }
    | {
        mode: "kiosk";
        academyId: string;
        studentId: string;
        sender: AttendanceSender;
        studentData: Record<string, unknown>;
      },
): Promise<DepartureOutcome> {
  const { academyId, studentId } = params;
  const date = seoulDateString();
  let sender: AttendanceSender;
  let studentData: Record<string, unknown>;
  let via: DepartureVia;
  if (params.mode === "button") {
    assertRecordDate(params.date, date);
    ({ sender, studentData } = await assertArrivalAccess(db, academyId, studentId, params.callerUid, "하원 처리"));
    via = params.via;
  } else {
    sender = params.sender;
    studentData = params.studentData;
    via = "kiosk";
  }
  const result = await writeDeparture(db, { academyId, studentId, sender, via, mode: params.mode, date });
  if (!result.changed) {
    return { ok: true, changed: false, alreadyLeft: true, message: ALREADY_LEFT_MESSAGE, notification: null };
  }
  const notification = await sendStudentAttendanceNotificationCore(db, {
    academyId,
    studentId,
    kind: "left",
    sender,
    studentData,
    body: departurePushBody(studentNameOf(studentData), new Date()),
    notify: { context: "departure" },
    limit: "daily_change",
    date,
  });
  return { ok: true, changed: true, alreadyLeft: false, message: null, notification };
}

/** 원장·출결 권한 직원·담당 선생님 — 오늘 하원(선택 입력 `date` = 화면 날짜) */
export const recordStudentDeparture = onCall(async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const data = (request.data ?? {}) as Record<string, unknown>;
  const academyId = requireId(data.academyId);
  const studentId = requireId(data.studentId);
  const via = parseVia(data.via, DEPARTURE_VIA, "attendance_screen");
  return recordDepartureCore(admin.firestore(), {
    mode: "button",
    academyId,
    studentId,
    via,
    callerUid: request.auth.uid,
    date: data.date,
  });
});

function senderForActor(actor: AcademyActor): AttendanceSender {
  return actor.kind === "owner"
    ? { role: "owner", actorUid: actor.uid, source: "academy_dashboard" }
    : { role: "teacher", actorUid: actor.uid, source: "teacher_dashboard" };
}

/** 원장·출결 권한 직원·담당 선생님 — 오늘 하원 기록 취소(정정 알림, 등원 기록은 그대로) */
export const cancelStudentDeparture = onCall(async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const callerUid = request.auth.uid;
  const data = (request.data ?? {}) as Record<string, unknown>;
  const academyId = requireId(data.academyId);
  const studentId = requireId(data.studentId);
  const via = parseVia(data.via, DEPARTURE_VIA, "attendance_screen");
  const today = seoulDateString();
  if (typeof data.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }
  if (data.date !== today) throw new HttpsError("failed-precondition", CANCEL_NOT_TODAY_MESSAGE);
  const date = today;

  const db = admin.firestore();
  const actor = await resolveAcademyActor(db, academyId, callerUid);
  if (!actor) throw new HttpsError("permission-denied", "하원 기록을 취소할 권한이 없습니다.");
  const sender = senderForActor(actor);
  const canAll = actor.kind === "owner" || actorHasPermission(actor, "lessons.attendance");
  const studentRef = db.doc(`academies/${academyId}/students/${studentId}`);
  const ref = arrivalRecordRef(db, academyId, studentId, date);

  const outcome = await db.runTransaction(async (tx) => {
    const [studentSnap, snap] = await tx.getAll(studentRef, ref);
    if (!studentSnap!.exists) throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
    const student = studentSnap!.data() as Record<string, unknown>;
    if (!canAll && !readUidList(student.teacherUids).includes(callerUid)) {
      throw new HttpsError("permission-denied", "담당 반 학생만 하원 기록을 취소할 수 있습니다.");
    }
    if (!snap!.exists || snap!.get("departed") !== true) return { changed: false as const };
    tx.update(ref, { ...DEPARTURE_FIELDS_DELETE, updatedAt: FieldValue.serverTimestamp() });
    return { changed: true as const, student };
  });

  if (!outcome.changed) return { ok: true as const, changed: false as const, notification: null };
  const notification = await sendStudentAttendanceNotificationCore(db, {
    academyId,
    studentId,
    kind: "left",
    sender,
    studentData: outcome.student,
    body: departureCancelPushBody(studentNameOf(outcome.student), new Date()),
    notify: { context: "departure" },
    limit: "daily_change",
    date,
    action: "cancel",
    via,
  });
  return { ok: true as const, changed: true as const, notification };
});

/**
 * 하원 정정(알림 없음·정정 이력 layer "departure") — `correctStudentDeparture`·일괄 공용.
 * - 지난 날짜: 만들기·바꾸기·지우기. 그날 등원 기록이 등원이어야 한다.
 * - 오늘: 이미 있는 하원의 시각만(★7 — 만들기·지우기는 하원 버튼·취소, 알림 있음).
 * `leftAtTime`: "HH:mm" = 그 시각(직접 입력 표시), null = 시각 지움, undefined = 이미 하원이면 그대로·아니면 시각 없음.
 * 하원 시각은 등원 시각보다 빠를 수 없다(★6). 차감 잠금 날도 허용(H3).
 */
export async function correctDepartureCore(
  db: admin.firestore.Firestore,
  params: {
    actor: AcademyActor;
    academyId: string;
    studentId: string;
    date: string;
    departed: boolean;
    leftAtTime?: string | null;
    via: CorrectionVia;
  },
): Promise<{ ok: true; changed: boolean; departed: boolean }> {
  const { actor, academyId, studentId, date, departed, leftAtTime, via } = params;
  const today = seoulDateString();
  const studentRef = db.doc(`academies/${academyId}/students/${studentId}`);
  const ref = arrivalRecordRef(db, academyId, studentId, date);
  const staffRef = staffRefFor(db, academyId, actor);

  return db.runTransaction(async (tx) => {
    const [studentSnap, snap, staffSnap] = await tx.getAll(studentRef, ref, ...(staffRef ? [staffRef] : []));
    const by = correctionActorFromTx(actor, staffSnap ?? null, CORRECTION_PERMISSION_MESSAGE);
    if (!studentSnap!.exists) throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
    const data = snap!.exists ? snap!.data() : undefined;
    const prev = departureStateOf(data);

    if (date === today) {
      if (!prev || !departed) throw new HttpsError("failed-precondition", TODAY_TIME_ONLY_MESSAGE);
      assertTodayTime(leftAtTime);
    }
    if (!departed) {
      if (!prev) return { ok: true as const, changed: false, departed: false };
      tx.update(ref, {
        ...DEPARTURE_FIELDS_DELETE,
        correctedAt: FieldValue.serverTimestamp(),
        correctedByUid: actor.uid,
        updatedAt: FieldValue.serverTimestamp(),
      });
      writeCorrectionTx(tx, db, {
        academyId, date, studentId, studentName: studentNameOf(studentSnap!.data()), classId: null, className: null,
        layer: "departure", action: "delete", before: prev, after: null, via, by,
      });
      return { ok: true as const, changed: true, departed: false };
    }

    const block = departureBlock(arrivalSnapshotOf(snap!));
    if (block === "no_arrival") {
      throw new HttpsError(
        "failed-precondition",
        `${dateLabel(date)} 등원 기록이 없어 하원을 기록할 수 없습니다. 등원 기록을 먼저 정정해 주세요.`,
      );
    }
    if (block === "absent_day") {
      throw new HttpsError(
        "failed-precondition",
        `${dateLabel(date)}은 미등원으로 기록되어 있어 하원을 기록할 수 없습니다. 등원 기록을 먼저 정정해 주세요.`,
      );
    }

    const keepTime = leftAtTime === undefined && prev !== null;
    const nextLeftAtMs =
      typeof leftAtTime === "string" ? seoulDateTimeMs(date, leftAtTime) : keepTime ? prev!.leftAt?.toMillis() ?? null : null;
    const arrivedAtMs = data?.arrivedAt instanceof Timestamp ? data.arrivedAt.toMillis() : null;
    if (nextLeftAtMs !== null && arrivedAtMs !== null && nextLeftAtMs < arrivedAtMs) {
      throw new HttpsError("invalid-argument", DEPARTURE_BEFORE_ARRIVAL_MESSAGE);
    }
    if (prev && (prev.leftAt?.toMillis() ?? null) === nextLeftAtMs) {
      return { ok: true as const, changed: false, departed: true };
    }

    const timeFields = keepTime
      ? {}
      : nextLeftAtMs !== null
        ? { leftAt: Timestamp.fromMillis(nextLeftAtMs), leftAtManual: true }
        : { leftAt: FieldValue.delete(), leftAtManual: FieldValue.delete() };
    tx.update(ref, {
      departed: true,
      ...timeFields,
      ...(prev
        ? {}
        : { leftByUid: actor.uid, leftByRole: actor.kind === "owner" ? "owner" : "teacher", leftSource: "academy_dashboard" }),
      leftVia: via,
      correctedAt: FieldValue.serverTimestamp(),
      correctedByUid: actor.uid,
      updatedAt: FieldValue.serverTimestamp(),
    });
    writeCorrectionTx(tx, db, {
      academyId, date, studentId, studentName: studentNameOf(studentSnap!.data()), classId: null, className: null,
      layer: "departure",
      action: prev ? "update" : "create",
      before: prev,
      after: { departed: true, leftAt: nextLeftAtMs !== null ? Timestamp.fromMillis(nextLeftAtMs) : null },
      via,
      by,
    });
    return { ok: true as const, changed: true, departed: true };
  });
}

const DEPARTURE_CORRECTION_VIA = ["attendance_screen", "student_detail"] as const;

/** 원장·출결 권한 — 하원 정정(지난 날짜 만들기·바꾸기·지우기, 오늘은 시각만). 알림 없음·정정 이력 */
export const correctStudentDeparture = onCall(async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const data = (request.data ?? {}) as Record<string, unknown>;
  const academyId = requireId(data.academyId);
  const studentId = requireId(data.studentId);
  if (typeof data.departed !== "boolean") throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  const departed = data.departed;
  const timeRaw = data.leftAtTime;
  if (timeRaw !== undefined && timeRaw !== null && (!isHHmm(timeRaw) || !departed)) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }
  const via = parseVia(data.via, DEPARTURE_CORRECTION_VIA, "attendance_screen");
  const date = requireNotFutureDate(data.date);
  if (date === seoulDateString()) {
    if (!departed) throw new HttpsError("failed-precondition", TODAY_TIME_ONLY_MESSAGE);
    assertTodayTime(timeRaw);
  }

  const db = admin.firestore();
  const actor = assertCorrectionActor(
    await resolveAcademyActor(db, academyId, request.auth.uid),
    CORRECTION_PERMISSION_MESSAGE,
  );
  return correctDepartureCore(db, {
    actor, academyId, studentId, date, departed,
    leftAtTime: timeRaw as string | null | undefined,
    via,
  });
});
