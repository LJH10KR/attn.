import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  attendanceSettingsRef,
  loadNotifySettings,
  sendStudentAttendanceNotificationCore,
  type AttendanceNotifyContext,
  type AttendanceSender,
} from "./attendance-send-core";
import { arrivalRecordRef, classAttendanceCol, requireId } from "./attendance";
import { actorHasPermission, resolveAcademyActor } from "./lib/academy-access";
import { assertCorrectionActor } from "./lib/attendance-corrections";
import {
  arrivalCancelPushBody,
  arrivalPushBody,
  ATTENDANCE_NOTIFY_TYPES,
  classAttendanceDocId,
  classCancelPushBody,
  classPushBody,
  classStatusOf,
  departureCancelPushBody,
  departurePushBody,
  isNotifyEnabled,
  RESEND_MESSAGES,
  resendBody,
  resendStateMatches,
  seoulDateString,
  type AttendanceNotifyContextName,
  type AttendanceNotifyKind,
  type AttendanceNotifyType,
} from "./lib/attendance-rules";

/**
 * 3-B 출결 설정(B6)·알림 다시 보내기(B9) — 결정 `docs/stage3-handoff/3-B-decisions.md`, 계획 `3-B-plan.md` ★8~★10.
 */

const SETTINGS_PERMISSION_MESSAGE = "출결 설정은 원장이나 출결 권한이 있는 직원만 바꿀 수 있습니다.";

/** 원장·출결 권한 — 학부모 알림 종류 7종 켜기·끄기(`meta/attendanceSettings`, 서버만 씀) */
export const updateAttendanceSettings = onCall(async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const data = (request.data ?? {}) as Record<string, unknown>;
  const academyId = requireId(data.academyId);
  const raw = data.notify;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }
  const src = raw as Record<string, unknown>;
  const keys = Object.keys(src);
  if (keys.some((k) => !(ATTENDANCE_NOTIFY_TYPES as readonly string[]).includes(k))) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }
  const notify = {} as Record<AttendanceNotifyType, boolean>;
  for (const t of ATTENDANCE_NOTIFY_TYPES) {
    if (typeof src[t] !== "boolean") throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
    notify[t] = src[t] as boolean;
  }

  const db = admin.firestore();
  const actor = assertCorrectionActor(await resolveAcademyActor(db, academyId, request.auth.uid), SETTINGS_PERMISSION_MESSAGE);
  await attendanceSettingsRef(db, academyId).set(
    { notify, updatedAt: FieldValue.serverTimestamp(), updatedByUid: actor.uid },
    { merge: true },
  );
  return { ok: true as const, notify };
});

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/**
 * 원장·출결 권한 — 알림 기록 한 건 다시 보내기(B9, ★10).
 * 조건: 그 알림의 기록 날짜·보낸 날이 모두 서울 오늘, 지금 기록 상태가 그 알림과 같음, 그 종류가 지금 켜져 있음.
 * 문구는 지금 기록으로 다시 만들어 앞에 "(다시 알림) "(기간 결석 요약만 저장된 문구), 하루 10회(같은 키)에 센다.
 */
export const resendAttendanceNotification = onCall(async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const data = (request.data ?? {}) as Record<string, unknown>;
  const academyId = requireId(data.academyId);
  const notificationId = requireId(data.notificationId);

  const db = admin.firestore();
  const actor = await resolveAcademyActor(db, academyId, request.auth.uid);
  if (!actor || (actor.kind === "staff" && !actorHasPermission(actor, "lessons.attendance"))) {
    throw new HttpsError("permission-denied", RESEND_MESSAGES.permission);
  }
  const itemSnap = await db.doc(`academies/${academyId}/attendanceNotifications/${notificationId}`).get();
  if (!itemSnap.exists) throw new HttpsError("not-found", RESEND_MESSAGES.notFound);
  const item = itemSnap.data()!;

  const today = seoulDateString();
  const createdAt = item.createdAt as { toDate?: () => Date } | undefined;
  const createdDay = createdAt?.toDate ? seoulDateString(createdAt.toDate()) : null;
  if (item.date !== today || createdDay !== today) {
    throw new HttpsError("failed-precondition", RESEND_MESSAGES.notToday);
  }

  const context: AttendanceNotifyContextName =
    item.context === "class" ? "class" : item.context === "departure" ? "departure" : "arrival";
  const kind: AttendanceNotifyKind =
    item.kind === "absent" ? "absent" : item.kind === "late" ? "late" : item.kind === "left" ? "left" : "present";
  const action = item.action === "cancel" ? ("cancel" as const) : ("record" as const);
  const studentId = str(item.studentId);
  const classId = str(item.classId);
  if (!studentId || (context === "class" && !classId)) throw new HttpsError("not-found", RESEND_MESSAGES.notFound);

  const settings = await loadNotifySettings(db, academyId);
  if (!isNotifyEnabled(settings, { context, kind, action })) {
    throw new HttpsError("failed-precondition", RESEND_MESSAGES.muted);
  }

  const [studentSnap, arrivalSnap, classSnap] = await Promise.all([
    db.doc(`academies/${academyId}/students/${studentId}`).get(),
    arrivalRecordRef(db, academyId, studentId, today).get(),
    context === "class"
      ? classAttendanceCol(db, academyId).doc(classAttendanceDocId(today, classId!, studentId)).get()
      : Promise.resolve(null),
  ]);
  if (!studentSnap.exists) throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
  const arrival = arrivalSnap.exists
    ? {
      status: arrivalSnap.get("status") === "absent" ? ("absent" as const) : ("present" as const),
      reason: str(arrivalSnap.get("reason")),
      departed: arrivalSnap.get("departed") === true,
    }
    : null;
  const classStatus = classSnap?.exists ? classStatusOf(classSnap.get("status")) : null;
  const matches = resendStateMatches(
    { context, kind, action, reason: str(item.reason), origin: str(item.origin) },
    { arrival, classStatus },
  );
  if (!matches) throw new HttpsError("failed-precondition", RESEND_MESSAGES.stateChanged);

  const studentData = studentSnap.data() as Record<string, unknown>;
  const name = typeof studentData.name === "string" && studentData.name ? studentData.name : "학생";
  const className = str(classSnap?.get("className")) ?? str(item.className) ?? "반";
  const lateMinutes = classStatus === "late" && typeof classSnap?.get("lateMinutes") === "number"
    ? (classSnap.get("lateMinutes") as number)
    : null;
  const now = new Date();
  let body: string;
  if (item.origin === "absence_period" && typeof item.body === "string" && item.body) {
    body = item.body;
  } else if (context === "departure") {
    body = action === "cancel" ? departureCancelPushBody(name, now) : departurePushBody(name, now);
  } else if (context === "class") {
    const slots = Array.isArray(classSnap?.get("slots")) ? (classSnap!.get("slots") as { start: string; end: string }[]) : [];
    body = action === "cancel"
      ? classCancelPushBody(name, className, kind === "left" ? "present" : kind, now)
      : classPushBody(name, className, classStatus ?? "present", slots, now, lateMinutes);
  } else {
    const status = kind === "absent" ? "absent" : "present";
    body = action === "cancel" ? arrivalCancelPushBody(name, status, now) : arrivalPushBody(name, status, now);
  }

  const sender: AttendanceSender = actor.kind === "owner"
    ? { role: "owner", actorUid: actor.uid, source: "academy_dashboard" }
    : { role: "teacher", actorUid: actor.uid, source: "academy_dashboard" };
  const notify: AttendanceNotifyContext =
    context === "class" ? { context: "class", classId: classId!, className } : { context };
  const notification = await sendStudentAttendanceNotificationCore(db, {
    academyId,
    studentId,
    kind,
    sender,
    studentData,
    body: resendBody(body),
    notify,
    limit: "daily_change",
    date: today,
    ...(action === "cancel" ? { action: "cancel" as const } : {}),
    ...(str(item.reason) ? { reason: str(item.reason)! } : {}),
    ...(item.origin === "absence_period" ? { origin: "absence_period" as const } : {}),
    lateMinutes,
    resendOfId: notificationId,
  });
  return { ok: true as const, notification };
});
