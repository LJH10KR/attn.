import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  arrivalRecordRef,
  arrivalSnapshotOf,
  billedLockError,
  classAttendanceCol,
  classAttendanceOnDatesQuery,
  isBilledRecord,
  parseVia,
  requireId,
} from "./attendance";
import { resolveAcademyActor, type AcademyActor } from "./lib/academy-access";
import {
  assertCorrectionActor,
  arrivalStateOf,
  classStateOf,
  correctionActorFromTx,
  mergedArrivalState,
  staffDocRef,
  studentNameOf,
  writeCorrectionTx,
  type ClassState,
  type CorrectionVia,
} from "./lib/attendance-corrections";
import {
  ATTENDANCE_NOTE_MAX_LENGTH,
  arrivalCorrectionCheck,
  arrivalCorrectionClassRecordsMessage,
  classAttendanceDocId,
  classCorrectionBlock,
  classCorrectionBlockMessage,
  CORRECTION_DATE_MESSAGES,
  CORRECTION_PERMISSION_MESSAGE,
  correctionDateBlock,
  DETAILS_PERMISSION_MESSAGE,
  isAbsenceReason,
  isHHmm,
  isValidDateString,
  REASON_NOT_ABSENT_MESSAGE,
  reasonForStatus,
  seoulDateString,
  seoulDateTimeMs,
  SESSION_DEDUCTION_LOCKED_MESSAGE,
  slotsOnWeekday,
  weekdayOfDate,
  type AbsenceReason,
  type ArrivalCorrectionPrev,
  type AttendanceStatus,
} from "./lib/attendance-rules";
import { readSchedule } from "./lib/class-schedule";
import { readUidList } from "./lib/parent-recipients";

/**
 * 3-A 지난 날짜 정정·사유와 코멘트 — 결정 `docs/stage3-handoff/3-A-start.md`(Q3·A4·A5·A7), 계획 `3-A-plan.md` 3장.
 * - 권한 = 원장·`lessons.attendance`(트랜잭션 안에서 직원 문서로 다시 확인). 권한 없는 선생님은 오늘만(기존 함수).
 * - 지난 날짜 정정은 학부모 알림·벨·알림 기록이 없고(하루 10회 세기에도 넣지 않음) 정정 이력을 남긴다.
 * - 재원·종강·그날 수업은 다시 보지 않는다(원장 판단). 불변식은 오늘과 같다(`attendance-rules.ts` 3-A 절).
 */

/** 화면에서 받는 정정 경로(일괄 `attendance_batch`는 서버 내부) */
const CORRECTION_REQUEST_VIA = ["attendance_screen", "student_detail"] as const;

/** 정정의 다음 상태 — present·absent, 지우기는 null(빠지면 형식 오류) */
function parseCorrectionStatus(raw: unknown): AttendanceStatus | null {
  if (raw === null) return null;
  if (raw === "present" || raw === "absent") return raw;
  throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
}

function parseOptionalReason(raw: unknown): AbsenceReason | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (isAbsenceReason(raw)) return raw;
  throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
}

/** 지난 날짜(서울 오늘보다 앞) — 형식이 틀리면 invalid-argument, 오늘·미래면 failed-precondition */
export function requirePastDate(raw: unknown, today: string = seoulDateString()): string {
  if (!isValidDateString(raw)) throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  const block = correctionDateBlock(raw, today);
  if (block) throw new HttpsError("failed-precondition", CORRECTION_DATE_MESSAGES[block]);
  return raw;
}

function staffRefFor(db: admin.firestore.Firestore, academyId: string, actor: AcademyActor) {
  return actor.kind === "staff" ? staffDocRef(db, academyId, actor.uid) : null;
}

/** 새 기록의 기록자 역할 — 지금 기록 함수와 같게(원장 owner, 직원 teacher) */
function recorderRole(actor: AcademyActor): "owner" | "teacher" {
  return actor.kind === "owner" ? "owner" : "teacher";
}

export type CorrectOutcome = { ok: true; changed: boolean; status: AttendanceStatus | null };

/**
 * 지난 날짜 등원 기록 정정(만들기·바꾸기·지우기) — `correctStudentArrival`·일괄 공용. 날짜는 호출한 쪽이 확인한다.
 * `arrivedAtTime`: "HH:mm" = 그 시각으로(직접 입력 표시), null = 시각 지움, undefined = 이미 등원이면 그대로·아니면 시각 없음(★2·B4).
 */
export async function correctArrivalCore(
  db: admin.firestore.Firestore,
  params: {
    actor: AcademyActor;
    academyId: string;
    studentId: string;
    date: string;
    status: AttendanceStatus | null;
    reason?: AbsenceReason;
    arrivedAtTime?: string | null;
    via: CorrectionVia;
  },
): Promise<CorrectOutcome> {
  const { actor, academyId, studentId, date, status, reason, arrivedAtTime, via } = params;
  const studentRef = db.doc(`academies/${academyId}/students/${studentId}`);
  const ref = arrivalRecordRef(db, academyId, studentId, date);
  const staffRef = staffRefFor(db, academyId, actor);

  return db.runTransaction(async (tx): Promise<CorrectOutcome> => {
    const [studentSnap, snap, staffSnap] = await tx.getAll(studentRef, ref, ...(staffRef ? [staffRef] : []));
    const by = correctionActorFromTx(actor, staffSnap ?? null, CORRECTION_PERMISSION_MESSAGE);
    if (!studentSnap!.exists) throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");

    const prevData = snap!.exists ? snap!.data() : undefined;
    const prevState = arrivalStateOf(prevData);
    const prev: ArrivalCorrectionPrev = prevState
      ? {
        status: prevState.status,
        billed: isBilledRecord(prevData),
        reason: prevState.reason,
        arrivedAtMs: prevState.arrivedAt?.toMillis() ?? null,
      }
      : null;

    // 다음 등원 시각 — "keep"이면 필드를 건드리지 않는다
    const keepTime = status === "present" && arrivedAtTime === undefined && prev?.status === "present";
    const nextArrivedAtMs =
      status !== "present"
        ? null
        : typeof arrivedAtTime === "string"
          ? seoulDateTimeMs(date, arrivedAtTime)
          : keepTime
            ? prev!.arrivedAtMs
            : null;
    const nextReason =
      status === "absent" ? reason ?? reasonForStatus("absent", prev?.status === "absent" ? prev.reason : null) : null;

    const leavesPresent = prev !== null && (status === null || (status === "absent" && prev.status !== "absent"));
    const classCount = leavesPresent
      ? (await tx.get(classAttendanceOnDatesQuery(db, academyId, studentId, [date]))).size
      : 0;
    const check = arrivalCorrectionCheck(prev, { status, reason: nextReason, arrivedAtMs: nextArrivedAtMs }, classCount);
    if (check === "unchanged") return { ok: true, changed: false, status };
    if (check === "billed") throw billedLockError([date], snap!.get("billedInvoicePeriod") as string);
    if (check === "has_class_records") {
      throw new HttpsError("failed-precondition", arrivalCorrectionClassRecordsMessage(date, classCount, status === null));
    }

    const studentName = studentNameOf(studentSnap!.data());
    if (status === null) {
      tx.delete(ref);
      writeCorrectionTx(tx, db, {
        academyId, date, studentId, studentName, classId: null, className: null,
        layer: "arrival", action: "delete", before: prevState, after: null, via, by,
      });
      return { ok: true, changed: true, status: null };
    }

    const timeFields = keepTime
      ? {}
      : nextArrivedAtMs !== null
        ? { arrivedAt: Timestamp.fromMillis(nextArrivedAtMs), arrivedAtManual: true }
        : { arrivedAt: FieldValue.delete(), arrivedAtManual: FieldValue.delete() };
    tx.set(
      ref,
      {
        date,
        status,
        reason: nextReason ?? FieldValue.delete(),
        ...timeFields,
        academyId,
        studentId,
        via,
        ...(prev
          ? {}
          : {
            recordedByUid: actor.uid,
            recordedByRole: recorderRole(actor),
            source: "academy_dashboard",
            createdAt: FieldValue.serverTimestamp(),
          }),
        ...(prev?.status !== status ? { statusChangedAt: FieldValue.serverTimestamp() } : {}),
        correctedAt: FieldValue.serverTimestamp(),
        correctedByUid: actor.uid,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    writeCorrectionTx(tx, db, {
      academyId, date, studentId, studentName, classId: null, className: null,
      layer: "arrival",
      action: prev ? "update" : "create",
      before: prevState,
      after: mergedArrivalState(prevState, {
        status,
        reason: nextReason,
        arrivedAt: keepTime ? "keep" : nextArrivedAtMs !== null ? Timestamp.fromMillis(nextArrivedAtMs) : null,
      }),
      via,
      by,
    });
    return { ok: true, changed: true, status };
  });
}

/**
 * 지난 날짜 반 출결 정정(만들기·바꾸기·지우기) — `correctClassAttendance`·일괄 공용.
 * 반 원생 = 현재 그 반 원생이거나 그날 그 반 기록이 이미 있는 원생. 반 문서가 지워졌어도 남은 기록은 고칠 수 있다.
 * 새로 만드는 기록의 `slots`는 그 요일 현재 시간표 스냅샷(없으면 빈 칸, ★11), 기존 기록은 원래 값 유지.
 */
export async function correctClassCore(
  db: admin.firestore.Firestore,
  params: {
    actor: AcademyActor;
    academyId: string;
    classId: string;
    studentId: string;
    date: string;
    status: AttendanceStatus | null;
    reason?: AbsenceReason;
    via: CorrectionVia;
  },
): Promise<CorrectOutcome> {
  const { actor, academyId, classId, studentId, date, status, reason, via } = params;
  const studentRef = db.doc(`academies/${academyId}/students/${studentId}`);
  const classRef = db.doc(`academies/${academyId}/classes/${classId}`);
  const recordRef = classAttendanceCol(db, academyId).doc(classAttendanceDocId(date, classId, studentId));
  const staffRef = staffRefFor(db, academyId, actor);

  return db.runTransaction(async (tx): Promise<CorrectOutcome> => {
    const [studentSnap, clsSnap, arrivalSnap, recordSnap, staffSnap] = await tx.getAll(
      studentRef,
      classRef,
      arrivalRecordRef(db, academyId, studentId, date),
      recordRef,
      ...(staffRef ? [staffRef] : []),
    );
    const by = correctionActorFromTx(actor, staffSnap ?? null, CORRECTION_PERMISSION_MESSAGE);
    if (!studentSnap!.exists) throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
    const recordExists = recordSnap!.exists;
    if (!recordExists && status === null) return { ok: true, changed: false, status };
    if (!recordExists && !clsSnap!.exists) throw new HttpsError("not-found", "반을 찾을 수 없습니다.");

    const student = studentSnap!.data() as Record<string, unknown>;
    const deduction = recordExists ? recordSnap!.get("sessionDeduction") : null;
    const block = classCorrectionBlock({
      next: status,
      recordExists,
      hasSessionDeduction: deduction !== undefined && deduction !== null,
      isMember: readUidList(student.classIds).includes(classId),
      arrival: arrivalSnapshotOf(arrivalSnap!),
    });
    if (block) throw new HttpsError("failed-precondition", classCorrectionBlockMessage(block, date));

    const prevState = classStateOf(recordExists ? recordSnap!.data() : undefined);
    const nextReason =
      status === "absent"
        ? reason ?? reasonForStatus("absent", prevState?.status === "absent" ? prevState.reason : null)
        : null;
    if (prevState && status !== null && prevState.status === status && (status === "present" || prevState.reason === nextReason)) {
      return { ok: true, changed: false, status };
    }

    const currentName = clsSnap!.exists ? clsSnap!.get("name") : null;
    const snapshotName = recordExists ? recordSnap!.get("className") : null;
    const className =
      typeof currentName === "string" && currentName
        ? currentName
        : typeof snapshotName === "string" && snapshotName
          ? snapshotName
          : "반";
    const studentName = studentNameOf(student);

    if (status === null) {
      tx.delete(recordRef);
      writeCorrectionTx(tx, db, {
        academyId, date, studentId, studentName, classId, className,
        layer: "class", action: "delete", before: prevState, after: null, via, by,
      });
      return { ok: true, changed: true, status: null };
    }

    const slots = recordExists
      ? {}
      : {
        slots: slotsOnWeekday(readSchedule(clsSnap!.get("schedule")), weekdayOfDate(date)).map((s) => ({
          start: s.start,
          end: s.end,
        })),
      };
    tx.set(
      recordRef,
      {
        academyId,
        date,
        classId,
        studentId,
        status,
        reason: nextReason ?? FieldValue.delete(),
        className,
        ...slots,
        via,
        ...(recordExists
          ? {}
          : {
            markedByUid: actor.uid,
            markedByRole: recorderRole(actor),
            source: "academy_dashboard",
            createdAt: FieldValue.serverTimestamp(),
          }),
        ...(prevState?.status !== status ? { statusChangedAt: FieldValue.serverTimestamp() } : {}),
        correctedAt: FieldValue.serverTimestamp(),
        correctedByUid: actor.uid,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    const after: ClassState = { status, reason: nextReason, comment: prevState?.comment ?? null };
    writeCorrectionTx(tx, db, {
      academyId, date, studentId, studentName, classId, className,
      layer: "class", action: recordExists ? "update" : "create", before: prevState, after, via, by,
    });
    return { ok: true, changed: true, status };
  });
}

/** 원장·출결 권한 — 지난 날짜 등원 기록 정정(알림 없음, 정정 이력) */
export const correctStudentArrival = onCall(async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const data = (request.data ?? {}) as Record<string, unknown>;
  const academyId = requireId(data.academyId);
  const studentId = requireId(data.studentId);
  const status = parseCorrectionStatus(data.status);
  const reason = parseOptionalReason(data.reason);
  if (reason !== undefined && status !== "absent") throw new HttpsError("invalid-argument", REASON_NOT_ABSENT_MESSAGE);
  const timeRaw = data.arrivedAtTime;
  if (timeRaw !== undefined && timeRaw !== null && (!isHHmm(timeRaw) || status !== "present")) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }
  const via = parseVia(data.via, CORRECTION_REQUEST_VIA, "attendance_screen");
  const date = requirePastDate(data.date);

  const db = admin.firestore();
  const actor = assertCorrectionActor(
    await resolveAcademyActor(db, academyId, request.auth.uid),
    CORRECTION_PERMISSION_MESSAGE,
  );
  return correctArrivalCore(db, {
    actor, academyId, studentId, date, status, reason,
    arrivedAtTime: timeRaw as string | null | undefined,
    via,
  });
});

/** 원장·출결 권한 — 지난 날짜 반 출결 정정(알림 없음, 정정 이력) */
export const correctClassAttendance = onCall(async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const data = (request.data ?? {}) as Record<string, unknown>;
  const academyId = requireId(data.academyId);
  const classId = requireId(data.classId);
  const studentId = requireId(data.studentId);
  const status = parseCorrectionStatus(data.status);
  const reason = parseOptionalReason(data.reason);
  if (reason !== undefined && status !== "absent") throw new HttpsError("invalid-argument", REASON_NOT_ABSENT_MESSAGE);
  const via = parseVia(data.via, CORRECTION_REQUEST_VIA, "attendance_screen");
  const date = requirePastDate(data.date);

  const db = admin.firestore();
  const actor = assertCorrectionActor(
    await resolveAcademyActor(db, academyId, request.auth.uid),
    CORRECTION_PERMISSION_MESSAGE,
  );
  return correctClassCore(db, { actor, academyId, classId, studentId, date, status, reason, via });
});

/**
 * 원장·출결 권한 — 사유·메모(등원 기록 `note`)·코멘트(반 출결 `comment`) 바꾸기(A7). 날짜와 상관없이,
 * 기록을 유지한 채 바꾸고 알림은 없다. 정정 이력(action "detail")을 남긴다.
 * 사유는 미등원·결석 기록에만. 차감 잠금 날 등원 기록은 사유 거부·메모 허용(★4), 회차 차감이 연결된 반 출결은 사유 거부.
 */
export const updateAttendanceDetails = onCall(async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const data = (request.data ?? {}) as Record<string, unknown>;
  const academyId = requireId(data.academyId);
  const studentId = requireId(data.studentId);
  const layer = data.layer === "arrival" || data.layer === "class" ? data.layer : null;
  if (!layer || !isValidDateString(data.date)) throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  const date = data.date;
  const classId = layer === "class" ? requireId(data.classId) : null;
  const reason = parseOptionalReason(data.reason);
  let note: string | undefined;
  if (data.note !== undefined && data.note !== null) {
    if (typeof data.note !== "string") throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
    note = data.note.trim().slice(0, ATTENDANCE_NOTE_MAX_LENGTH);
  }
  if (reason === undefined && note === undefined) throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  const via = parseVia(data.via, CORRECTION_REQUEST_VIA, "attendance_screen");

  const db = admin.firestore();
  const actor = assertCorrectionActor(
    await resolveAcademyActor(db, academyId, request.auth.uid),
    DETAILS_PERMISSION_MESSAGE,
  );
  const studentRef = db.doc(`academies/${academyId}/students/${studentId}`);
  const recordRef =
    layer === "arrival"
      ? arrivalRecordRef(db, academyId, studentId, date)
      : classAttendanceCol(db, academyId).doc(classAttendanceDocId(date, classId!, studentId));
  const staffRef = staffRefFor(db, academyId, actor);
  const noteField = layer === "arrival" ? "note" : "comment";

  return db.runTransaction(async (tx) => {
    const [studentSnap, recordSnap, staffSnap] = await tx.getAll(
      studentRef,
      recordRef,
      ...(staffRef ? [staffRef] : []),
    );
    const by = correctionActorFromTx(actor, staffSnap ?? null, DETAILS_PERMISSION_MESSAGE);
    if (!studentSnap!.exists) throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
    if (!recordSnap!.exists) throw new HttpsError("not-found", "출결 기록을 찾을 수 없습니다.");
    const record = recordSnap!.data()!;
    const status: AttendanceStatus = record.status === "absent" ? "absent" : "present";
    if (reason !== undefined && status !== "absent") {
      throw new HttpsError("invalid-argument", REASON_NOT_ABSENT_MESSAGE);
    }
    const currentReason = typeof record.reason === "string" && record.reason ? record.reason : null;
    const currentNote = typeof record[noteField] === "string" && record[noteField] ? (record[noteField] as string) : null;
    const reasonChanged = reason !== undefined && reason !== currentReason;
    const noteChanged = note !== undefined && (note || null) !== currentNote;
    if (!reasonChanged && !noteChanged) return { ok: true as const, changed: false as const };
    if (reasonChanged && layer === "arrival" && isBilledRecord(record)) {
      throw billedLockError([date], record.billedInvoicePeriod as string);
    }
    if (reasonChanged && layer === "class" && record.sessionDeduction !== undefined && record.sessionDeduction !== null) {
      throw new HttpsError("failed-precondition", SESSION_DEDUCTION_LOCKED_MESSAGE);
    }

    tx.update(recordRef, {
      ...(reasonChanged ? { reason } : {}),
      ...(noteChanged ? { [noteField]: note ? note : FieldValue.delete() } : {}),
      correctedAt: FieldValue.serverTimestamp(),
      correctedByUid: actor.uid,
      updatedAt: FieldValue.serverTimestamp(),
    });
    const nextReason = reasonChanged ? reason! : currentReason;
    const nextNote = noteChanged ? note || null : currentNote;
    const className =
      layer === "class" && typeof record.className === "string" && record.className ? record.className : null;
    if (layer === "arrival") {
      const before = arrivalStateOf(record);
      writeCorrectionTx(tx, db, {
        academyId, date, studentId, studentName: studentNameOf(studentSnap!.data()), classId: null, className: null,
        layer, action: "detail", before,
        after: before ? { ...before, reason: nextReason, note: nextNote } : null,
        via, by,
      });
    } else {
      const before = classStateOf(record);
      writeCorrectionTx(tx, db, {
        academyId, date, studentId, studentName: studentNameOf(studentSnap!.data()), classId, className,
        layer, action: "detail", before,
        after: before ? { ...before, reason: nextReason, comment: nextNote } : null,
        via, by,
      });
    }
    return { ok: true as const, changed: true as const };
  });
});
