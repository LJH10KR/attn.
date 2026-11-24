import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { classAttendanceCol, classCancellationRef, requireId } from "./attendance";
import { classStatusOf, formatSeoulHHmm, seoulDateString, type ClassStatus } from "./lib/attendance-rules";
import { readUidList } from "./lib/parent-recipients";
import { normalizeStudentStatus } from "./lib/student-profile";

/**
 * 3-B 학부모 앱 자녀 출결 기록(B8, 계획 ★13·P2) — Callable로만 읽는다(규칙은 그대로, 학부모는 출결 문서를 못 읽음).
 * - 연결된 자녀만: 이 학원 학부모 문서가 active이고, 학생 `parentUids`에 있고, 재원·휴원 자녀(자녀 목록과 같음).
 * - 오늘 포함 최근 31일, 기록이 있는 날만(등원 기록 없이 휴강만 있는 날도 포함).
 * - 학원 메모(`note`)·코멘트(`comment`)·휴강 메모·처리한 사람은 보내지 않는다.
 * - 색인 추가 없음: 반 출결은 `studentId ==` + `date in`(30개씩), 휴강은 문서 ID(`{date}_{classId}`)로 getAll(P2).
 */

export const ATTENDANCE_HISTORY_DAYS = 31;
const DAY_MS = 86_400_000;
const GET_ALL_CHUNK = 100;

export type HistoryDay = {
  date: string;
  arrival: {
    status: "present" | "absent";
    arrivedAt: string | null;
    departed: boolean;
    leftAt: string | null;
    reason: string | null;
  } | null;
  classes: { classId: string; className: string; status: ClassStatus; lateMinutes: number | null; reason: string | null }[];
  cancellations: { classId: string; className: string }[];
  corrected: boolean;
};

/** 오늘 포함 지난 N일(오래된 날부터) */
export function recentSeoulDates(today: string, days: number): string[] {
  const base = Date.parse(`${today}T12:00:00+09:00`);
  return Array.from({ length: days }, (_, i) => seoulDateString(new Date(base - (days - 1 - i) * DAY_MS)));
}

function hhmm(v: unknown): string | null {
  return v instanceof Timestamp ? formatSeoulHHmm(v.toDate()) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

const DENIED_MESSAGE = "연결된 자녀의 출결 기록만 볼 수 있습니다.";

export const getStudentAttendanceHistory = onCall(async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const uid = request.auth.uid;
  const data = (request.data ?? {}) as Record<string, unknown>;
  const academyId = requireId(data.academyId);
  const studentId = requireId(data.studentId);

  const db = admin.firestore();
  const [parentSnap, studentSnap] = await db.getAll(
    db.doc(`academies/${academyId}/parents/${uid}`),
    db.doc(`academies/${academyId}/students/${studentId}`),
  );
  if (!parentSnap!.exists || parentSnap!.get("status") !== "active") {
    throw new HttpsError("permission-denied", "이 학원의 활성 학부모만 자녀 출결 기록을 볼 수 있습니다.");
  }
  const student = studentSnap!.exists ? (studentSnap!.data() as Record<string, unknown>) : null;
  const visible = student && ["enrolled", "on_leave"].includes(normalizeStudentStatus(student.status));
  if (!student || !visible || !readUidList(student.parentUids).includes(uid)) {
    throw new HttpsError("permission-denied", DENIED_MESSAGE);
  }

  const today = seoulDateString();
  const dates = recentSeoulDates(today, ATTENDANCE_HISTORY_DAYS);
  const start = dates[0]!;

  const [arrivalSnap, ...classSnaps] = await Promise.all([
    db
      .collection(`academies/${academyId}/students/${studentId}/attendanceRecords`)
      .where("date", ">=", start)
      .where("date", "<=", today)
      .get(),
    ...[dates.slice(0, 30), dates.slice(30)]
      .filter((chunk) => chunk.length > 0)
      .map((chunk) => classAttendanceCol(db, academyId).where("studentId", "==", studentId).where("date", "in", chunk).get()),
  ]);

  const days = new Map<string, HistoryDay>();
  const dayOf = (date: string): HistoryDay => {
    let d = days.get(date);
    if (!d) {
      d = { date, arrival: null, classes: [], cancellations: [], corrected: false };
      days.set(date, d);
    }
    return d;
  };

  for (const doc of arrivalSnap.docs) {
    const x = doc.data();
    const date = str(x.date) ?? doc.id;
    const d = dayOf(date);
    const status = x.status === "absent" ? "absent" : "present";
    d.arrival = {
      status,
      arrivedAt: status === "present" ? hhmm(x.arrivedAt) : null,
      departed: status === "present" && x.departed === true,
      leftAt: status === "present" && x.departed === true ? hhmm(x.leftAt) : null,
      reason: status === "absent" ? str(x.reason) : null,
    };
    if (x.correctedAt != null) d.corrected = true;
  }

  const classIds = new Set(readUidList(student.classIds));
  for (const snap of classSnaps) {
    for (const doc of snap.docs) {
      const x = doc.data();
      const classId = str(x.classId);
      const date = str(x.date);
      if (!classId || !date) continue;
      classIds.add(classId);
      const status = classStatusOf(x.status);
      const d = dayOf(date);
      d.classes.push({
        classId,
        className: str(x.className) ?? "반",
        status,
        lateMinutes: status === "late" && typeof x.lateMinutes === "number" ? x.lateMinutes : null,
        reason: status === "absent" ? str(x.reason) : null,
      });
      if (x.correctedAt != null) d.corrected = true;
    }
  }

  // 휴강 — 31일 × 그 원생 반(현재 반 ∪ 기록에 나온 반)을 문서 ID로(P2)
  const refs = [...classIds].flatMap((classId) => dates.map((date) => classCancellationRef(db, academyId, date, classId)));
  for (let i = 0; i < refs.length; i += GET_ALL_CHUNK) {
    const snaps = await db.getAll(...refs.slice(i, i + GET_ALL_CHUNK));
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const classId = str(snap.get("classId"));
      const date = str(snap.get("date"));
      if (!classId || !date) continue;
      dayOf(date).cancellations.push({ classId, className: str(snap.get("className")) ?? "반" });
    }
  }

  const out = [...days.values()]
    .map((d) => ({
      ...d,
      classes: d.classes.sort((a, b) => a.className.localeCompare(b.className, "ko")),
      cancellations: d.cancellations.sort((a, b) => a.className.localeCompare(b.className, "ko")),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
  return { ok: true as const, from: start, to: today, days: out };
});
