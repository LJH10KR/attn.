import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { assertCanManageAcademy } from "./lib/academy-access";
import {
  sendStudentAttendanceNotificationCore,
  type AttendanceSender,
} from "./attendance-send-core";

/**
 * 학생 출결 기록 — `academies/{academyId}/students/{studentId}/attendanceRecords/{YYYY-MM-DD}`
 * 문서 ID가 서울 기준 날짜라 학생·날짜당 1건만 존재. 쓰기는 Functions(Admin SDK)만.
 * 알림(`attendanceNotifications`)과 별개로, 원비 차감 등 날짜 단위 판단의 근거로 사용.
 */

export type AttendanceStatus = "present" | "absent";

/** 결석 사유 — illness·academy는 학원 측 사유로 원비 차감 대상(3단계 청구서에서 사용) */
export type AbsenceReason = "general" | "illness" | "academy";

const ABSENCE_REASONS: readonly AbsenceReason[] = ["general", "illness", "academy"];

/** 원장·포털만 지정 가능한 사유 — 선생님 결석 버튼이 덮어쓰지 않음 */
const DEDUCTIBLE_ABSENCE_REASONS: readonly AbsenceReason[] = ["illness", "academy"];

const ABSENCE_REASON_LABELS: Record<AbsenceReason, string> = {
  general: "일반",
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

function isDeductibleReason(raw: unknown): boolean {
  return typeof raw === "string" && (DEDUCTIBLE_ABSENCE_REASONS as readonly string[]).includes(raw);
}

/** 청구서 결석 차감에 반영된 기록(`applyAbsenceDeduction`이 설정) */
function isBilled(data: FirebaseFirestore.DocumentData | undefined): boolean {
  return typeof data?.billedInvoicePeriod === "string" && data.billedInvoicePeriod.length > 0;
}

function billedLockError(dates: string[], period: string): HttpsError {
  const [, m] = period.split("-").map(Number);
  return new HttpsError(
    "failed-precondition",
    `${dates.map(formatDateLabel).join(", ")} 기록은 ${m}월 청구서 결석 차감에 반영되어 있어 변경할 수 없습니다. ` +
      "청구서에서 해당 차감을 먼저 삭제해 주세요.",
  );
}

function formatDateLabel(dateStr: string): string {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${m}월 ${d}일`;
}

/**
 * 오늘자 출결 기록 — 출석·결석 버튼(선생님·학원)과 키오스크 출석에서 알림 전송 전에 호출.
 * - 출석: 항상 덮어씀(실제 등원이 확인된 것이므로 학원 측 결석 사유보다 우선).
 * - 결석(일반): 이미 원장·포털이 차감 대상 사유(질병·학원 사정)로 기록했다면 사유를 유지.
 * 반환값은 저장된 결석 사유(출석이면 null) — 알림 기록에 실제 사유를 남기기 위함.
 */
export async function upsertTodayAttendanceRecord(
  db: admin.firestore.Firestore,
  params: {
    academyId: string;
    studentId: string;
    status: AttendanceStatus;
    sender: AttendanceSender;
  },
): Promise<AbsenceReason | null> {
  const { academyId, studentId, status, sender } = params;
  const date = seoulDateString();
  const ref = attendanceRecordRef(db, academyId, studentId, date);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data() ?? {} : {};

    // 청구서 차감에 반영된 기록은 잠금 — 버튼·키오스크 출석으로도 바꾸지 않음(알림은 그대로 발송)
    if (isBilled(prev)) {
      logger.info("upsertTodayAttendanceRecord: billed record kept", { academyId, studentId, date });
      return prev.status === "absent" && isAbsenceReason(prev.reason) ? prev.reason : null;
    }

    if (status === "absent" && prev.status === "absent" && isDeductibleReason(prev.reason)) {
      return prev.reason as AbsenceReason;
    }

    tx.set(ref, {
      date,
      status,
      ...(status === "absent" ? { reason: "general" satisfies AbsenceReason } : {}),
      recordedByUid: sender.actorUid,
      recordedByRole: sender.role,
      source: sender.source,
      createdAt: snap.exists && prev.createdAt ? prev.createdAt : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return status === "absent" ? "general" : null;
  });
}

function academySenderFromToken(
  uid: string,
  token: admin.auth.DecodedIdToken,
  academyId: string,
): AttendanceSender {
  const isPortal = token.role === "academy" && token.academyId === academyId;
  return {
    role: isPortal ? "academy" : "owner",
    actorUid: uid,
    source: "academy_dashboard",
    canBypassCooldown: false,
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
  await assertCanManageAcademy(db, academyId, uid, token);

  const studentSnap = await db.doc(`academies/${academyId}/students/${studentId}`).get();
  if (!studentSnap.exists) {
    throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
  }
  const sender = academySenderFromToken(uid, token, academyId);
  const refs = dates.map((d) => attendanceRecordRef(db, academyId, studentId, d));

  await db.runTransaction(async (tx) => {
    const snaps = await tx.getAll(...refs);
    const billed = snaps.filter((s) => isBilled(s.data()));
    if (billed.length > 0) {
      throw billedLockError(
        billed.map((s) => s.id),
        billed[0]!.get("billedInvoicePeriod") as string,
      );
    }
    snaps.forEach((snap, i) => {
      const prevCreatedAt = snap.exists ? snap.get("createdAt") : null;
      tx.set(refs[i]!, {
        date: dates[i],
        status: "absent" satisfies AttendanceStatus,
        reason,
        ...(note ? { note } : {}),
        recordedByUid: sender.actorUid,
        recordedByRole: sender.role,
        source: sender.source,
        createdAt: prevCreatedAt ?? FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  });

  if (!notifyParent) {
    return { ok: true as const, recordedCount: dates.length, notification: null };
  }

  const studentData = studentSnap.data() as Record<string, unknown>;
  const studentName =
    typeof studentData.name === "string" && studentData.name ? studentData.name : "학생";
  const dateLabel =
    dates.length === 1
      ? formatDateLabel(dates[0]!)
      : `${formatDateLabel(dates[0]!)} 외 ${dates.length - 1}일`;
  const body = `'${studentName}' 학생이 결석 처리되었습니다. (${dateLabel} · 사유: ${ABSENCE_REASON_LABELS[reason]})`;

  try {
    const result = await sendStudentAttendanceNotificationCore(db, {
      academyId,
      studentId,
      kind: "absent",
      sender,
      studentData,
      body,
      reason,
    });
    return { ok: true as const, recordedCount: dates.length, notification: result };
  } catch (e) {
    if (e instanceof HttpsError && e.code === "resource-exhausted") {
      return {
        ok: true as const,
        recordedCount: dates.length,
        notification: { ok: true as const, sent: 0, reason: "cooldown" as const },
      };
    }
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
  await assertCanManageAcademy(db, academyId, request.auth.uid, request.auth.token);

  const ref = attendanceRecordRef(db, academyId, studentId, date);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "출결 기록을 찾을 수 없습니다.");
  }
  if (isBilled(snap.data())) {
    throw billedLockError([date], snap.get("billedInvoicePeriod") as string);
  }
  await ref.delete();
  return { ok: true as const };
});
