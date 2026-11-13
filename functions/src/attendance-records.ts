import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { assertPermission, type AcademyActor } from "./lib/academy-access";
import { isActiveStudent } from "./lib/student-profile";
import {
  sendStudentAttendanceNotificationCore,
  type AttendanceSender,
} from "./attendance-send-core";
import {
  billedLockError,
  classAttendanceOnDatesQuery,
  isBilledRecord as isBilled,
} from "./attendance";
import {
  arrivalStateOf,
  correctionActorOutsideTx,
  studentNameOf,
  writeCorrectionTx,
} from "./lib/attendance-corrections";

/**
 * 등원 기록(2-I) — `academies/{academyId}/students/{studentId}/attendanceRecords/{YYYY-MM-DD}`,
 * present = 등원, absent = 미등원. 문서 ID가 서울 기준 날짜라 학생·날짜당 1건만 존재. 쓰기는 Functions(Admin SDK)만.
 * 이 파일은 원장·출결 권한의 기간 결석(사유 있는 미등원) 기록·기록 삭제 — 등원·미등원 버튼은 `attendance.ts`.
 * 알림(`attendanceNotifications`)과 별개로, 월정액 결석 차감 등 날짜 단위 판단의 근거로 사용.
 */

export type AttendanceStatus = "present" | "absent";

/** 결석 사유 — illness·academy는 학원 측 사유로 원비 차감 대상(3단계 청구서에서 사용) */
export type AbsenceReason = "general" | "illness" | "academy";

const ABSENCE_REASONS: readonly AbsenceReason[] = ["general", "illness", "academy"];

const ABSENCE_REASON_LABELS: Record<AbsenceReason, string> = {
  general: "기타",
  illness: "질병",
  academy: "학원 사정",
};

/** 한 번에 기록 가능한 결석 일수 */
const MAX_ABSENCE_DATES_PER_REQUEST = 31;
/** 소급 입력 허용 범위(일) */
const MAX_PAST_DAYS = 92;
/** 미리 입력 허용 범위(일) — 휴원 공지·격리 기간 등 */
const MAX_FUTURE_DAYS = 31;
const MAX_NOTE_LENGTH = 200;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type AttendanceRecordRole = AttendanceSender["role"];

export function seoulDateString(date: Date = new Date()): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/** "YYYY-MM-DD" → 서울 자정 ms (형식·실존 날짜가 아니면 null) */
function seoulDateMs(dateStr: string): number | null {
  if (!DATE_RE.test(dateStr)) return null;
  const ms = new Date(`${dateStr}T00:00:00+09:00`).getTime();
  if (!Number.isFinite(ms) || seoulDateString(new Date(ms)) !== dateStr) return null;
  return ms;
}

function attendanceRecordRef(
  db: admin.firestore.Firestore,
  academyId: string,
  studentId: string,
  date: string,
) {
  return db.doc(`academies/${academyId}/students/${studentId}/attendanceRecords/${date}`);
}

function isAbsenceReason(raw: unknown): raw is AbsenceReason {
  return typeof raw === "string" && (ABSENCE_REASONS as readonly string[]).includes(raw);
}

function formatDateLabel(dateStr: string): string {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${m}월 ${d}일`;
}

/** 그 날짜들 중 반 출결이 있는 날짜(정렬) — `in`은 30개까지라 나눠 조회 */
async function classAttendanceDatesTx(
  tx: FirebaseFirestore.Transaction,
  db: admin.firestore.Firestore,
  academyId: string,
  studentId: string,
  dates: readonly string[],
): Promise<string[]> {
  const found = new Set<string>();
  for (let i = 0; i < dates.length; i += 30) {
    const snap = await tx.get(classAttendanceOnDatesQuery(db, academyId, studentId, dates.slice(i, i + 30)));
    snap.docs.forEach((d) => found.add(d.get("date") as string));
  }
  return [...found].sort();
}

/** 학원 화면의 작업 주체 → 기록자 역할(권한을 위임받은 직원은 teacher) */
export function academySenderForActor(actor: AcademyActor): AttendanceSender {
  return {
    role: actor.kind === "staff" ? "teacher" : "owner",
    actorUid: actor.uid,
    source: "academy_dashboard",
  };
}

function parseAbsenceDates(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpsError("invalid-argument", "결석 날짜를 선택해 주세요.");
  }
  const dates = [...new Set(raw.filter((x): x is string => typeof x === "string"))].sort();
  if (dates.length !== raw.length) {
    throw new HttpsError("invalid-argument", "결석 날짜 형식이 올바르지 않습니다.");
  }
  if (dates.length > MAX_ABSENCE_DATES_PER_REQUEST) {
    throw new HttpsError(
      "invalid-argument",
      `결석은 한 번에 최대 ${MAX_ABSENCE_DATES_PER_REQUEST}일까지 기록할 수 있습니다.`,
    );
  }
  const todayMs = seoulDateMs(seoulDateString())!;
  for (const d of dates) {
    const ms = seoulDateMs(d);
    if (ms == null) {
      throw new HttpsError("invalid-argument", "결석 날짜 형식이 올바르지 않습니다.");
    }
    if (ms < todayMs - MAX_PAST_DAYS * DAY_MS || ms > todayMs + MAX_FUTURE_DAYS * DAY_MS) {
      throw new HttpsError(
        "invalid-argument",
        `결석은 최근 ${MAX_PAST_DAYS}일 ~ 앞으로 ${MAX_FUTURE_DAYS}일 범위에서만 기록할 수 있습니다.`,
      );
    }
  }
  return dates;
}

/**
 * 원장·학원 포털 — 날짜(여러 날 가능)를 지정해 결석과 사유를 기록. 같은 날짜 기록은 덮어씀(사유 변경 포함).
 * notifyParent가 true면 학부모에게 1건의 요약 알림을 보냄(쿨다운 중이면 기록만 저장).
 */
export const recordStudentAbsences = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const studentId =
    typeof request.data?.studentId === "string" ? request.data.studentId.trim() : "";
  if (!academyId || !studentId) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }
  const reason = request.data?.reason;
  if (!isAbsenceReason(reason)) {
    throw new HttpsError("invalid-argument", "결석 사유가 올바르지 않습니다.");
  }
  const noteRaw = request.data?.note;
  const note = typeof noteRaw === "string" ? noteRaw.trim().slice(0, MAX_NOTE_LENGTH) : "";
  const notifyParent = request.data?.notifyParent === true;
  const dates = parseAbsenceDates(request.data?.dates);

  const db = admin.firestore();
  const actor = await assertPermission(db, academyId, uid, token, "lessons.attendance");

  const studentSnap = await db.doc(`academies/${academyId}/students/${studentId}`).get();
  if (!studentSnap.exists) {
    throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
  }
  const sender = academySenderForActor(actor);
  const refs = dates.map((d) => attendanceRecordRef(db, academyId, studentId, d));
  // 3-A ★5: 지난 날짜의 기존 기록을 다른 내용으로 덮으면 정정 이력
  const today = seoulDateString();
  const by = dates.some((d) => d < today) ? await correctionActorOutsideTx(db, academyId, actor) : null;
  const studentName = studentNameOf(studentSnap.data());

  await db.runTransaction(async (tx) => {
    const snaps = await tx.getAll(...refs);
    const billed = snaps.filter((s) => isBilled(s.data()));
    if (billed.length > 0) {
      throw billedLockError(
        billed.map((s) => s.id),
        billed[0]!.get("billedInvoicePeriod") as string,
      );
    }
    // 그날 반 출결이 있으면 미등원으로 바꾸지 않는다(등원 → 미등원은 반 출결 0건일 때만, 2-I ★7)
    const classDates = await classAttendanceDatesTx(tx, db, academyId, studentId, dates);
    if (classDates.length > 0) {
      throw new HttpsError(
        "failed-precondition",
        `${classDates.map(formatDateLabel).join(", ")}에는 수업 출결 기록이 있어 결석으로 기록할 수 없습니다.`,
      );
    }
    snaps.forEach((snap, i) => {
      const prev = snap.exists ? snap.data() ?? {} : {};
      const before = arrivalStateOf(snap.exists ? snap.data() : undefined);
      if (by && before && dates[i]! < today) {
        // 새 메모가 비어 있으면 기존 메모 유지(A7 — 기록을 유지한 채 바꾸기)
        const after = { status: "absent" as const, reason, note: note || before.note, arrivedAt: null };
        const same = before.status === after.status && before.reason === after.reason && before.note === after.note;
        if (!same) {
          writeCorrectionTx(tx, db, {
            academyId, date: dates[i]!, studentId, studentName, classId: null, className: null,
            layer: "arrival", action: "update", before, after, via: "student_detail", by,
          });
        }
      }
      // 3-A: 부분 갱신 — 빈 메모면 기존 메모·정정 표시 등 다른 필드는 유지, 미등원이므로 등원 시각은 지움
      tx.set(
        refs[i]!,
        {
          date: dates[i],
          status: "absent" satisfies AttendanceStatus,
          reason,
          ...(note ? { note } : {}),
          arrivedAt: FieldValue.delete(),
          arrivedAtManual: FieldValue.delete(),
          academyId,
          studentId,
          recordedByUid: sender.actorUid,
          recordedByRole: sender.role,
          source: sender.source,
          via: "absence_period",
          ...(prev.status === "absent" && prev.statusChangedAt ? {} : { statusChangedAt: FieldValue.serverTimestamp() }),
          ...(prev.createdAt ? {} : { createdAt: FieldValue.serverTimestamp() }),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
  });

  const studentData = studentSnap.data() as Record<string, unknown>;
  // 퇴원·휴원·미등록은 기록만 남기고 알림은 보내지 않는다
  if (!notifyParent || !isActiveStudent(studentData)) {
    return { ok: true as const, recordedCount: dates.length, notification: null };
  }

  const dateLabel =
    dates.length === 1
      ? formatDateLabel(dates[0]!)
      : `${formatDateLabel(dates[0]!)} 외 ${dates.length - 1}일`;
  const body = `'${studentName}' 학생이 결석 처리되었습니다. (${dateLabel} · 사유: ${ABSENCE_REASON_LABELS[reason]})`;

  try {
    // 기간 결석 요약 알림 — 등원 키를 같이 쓰되 60초 쿨다운(상태 바뀜 알림의 하루 횟수와 서로 막지 않음)
    const result = await sendStudentAttendanceNotificationCore(db, {
      academyId,
      studentId,
      kind: "absent",
      sender,
      studentData,
      body,
      reason,
      notify: { context: "arrival" },
      limit: "cooldown",
      date: dates[0]!,
    });
    return { ok: true as const, recordedCount: dates.length, notification: result };
  } catch (e) {
    logger.error("recordStudentAbsences: notification failed", { academyId, studentId, e });
    return {
      ok: true as const,
      recordedCount: dates.length,
      notification: { ok: false as const, sent: 0, reason: "failed" as const },
    };
  }
});

/** 원장·학원 포털 — 특정 날짜의 출결 기록 삭제(잘못 입력한 기록 정정, 청구 반영 기록은 불가) */
export const deleteStudentAttendanceRecord = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const studentId =
    typeof request.data?.studentId === "string" ? request.data.studentId.trim() : "";
  const date = typeof request.data?.date === "string" ? request.data.date.trim() : "";
  if (!academyId || !studentId || seoulDateMs(date) == null) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  const actor = await assertPermission(db, academyId, request.auth.uid, request.auth.token, "lessons.attendance");
  // 3-A ★5: 기록 삭제도 정정 이력
  const by = await correctionActorOutsideTx(db, academyId, actor);

  const ref = attendanceRecordRef(db, academyId, studentId, date);
  await db.runTransaction(async (tx) => {
    const [snap, studentSnap] = await tx.getAll(ref, db.doc(`academies/${academyId}/students/${studentId}`));
    if (!snap) throw new HttpsError("not-found", "출결 기록을 찾을 수 없습니다.");
    if (!snap.exists) {
      throw new HttpsError("not-found", "출결 기록을 찾을 수 없습니다.");
    }
    if (isBilled(snap.data())) {
      throw billedLockError([date], snap.get("billedInvoicePeriod") as string);
    }
    // 반 출결이 남아 있는 날의 등원 기록을 지우면 "등원 없이 출석"이 된다(2-I ★7)
    if ((await classAttendanceDatesTx(tx, db, academyId, studentId, [date])).length > 0) {
      throw new HttpsError(
        "failed-precondition",
        `${formatDateLabel(date)}에는 수업 출결 기록이 있어 등원 기록을 삭제할 수 없습니다.`,
      );
    }
    tx.delete(ref);
    writeCorrectionTx(tx, db, {
      academyId, date, studentId, studentName: studentNameOf(studentSnap?.data()), classId: null, className: null,
      layer: "arrival", action: "delete", before: arrivalStateOf(snap.data()), after: null, via: "student_detail", by,
    });
  });
  return { ok: true as const };
});
