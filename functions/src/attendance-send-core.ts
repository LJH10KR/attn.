import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import {
  createAttendancePushDeliveryDoc,
  deliverAttendancePushOnce,
} from "./attendance-push-delivery";
import {
  ATTENDANCE_DAILY_CHANGE_PUSH_LIMIT,
  notifyTypeFor,
  readNotifySettings,
  seoulDateString,
  type AttendanceNotifyKind,
  type AttendanceNotifyType,
} from "./lib/attendance-rules";
import { resolveParentRecipients } from "./lib/parent-recipients";

/** 기간 결석 요약 알림의 같은 원생 연속 전송 간격 */
export const ATTENDANCE_COOLDOWN_MS = 60_000;

/** 처리한 사람 — role·source는 서버가 처리한 사람으로 정한다(화면·via와 무관) */
export type AttendanceSender = {
  role: "teacher" | "owner" | "academy" | "student_kiosk";
  actorUid: string;
  source: "teacher_dashboard" | "academy_dashboard" | "student_kiosk";
};

/**
 * 알림 맥락(2-I, 3-B 하원) — 등원(날짜 단위)·반 출결(날짜 × 반)·하원(날짜 단위).
 * 쿨다운·횟수 키도 맥락별: 등원 `attendance_{academy}_{student}`(기간 결석과 공유),
 * 반 `class_attendance_{academy}_{class}_{student}`, 하원 `departure_{academy}_{student}`(B5 — 등원과 따로 하루 10회).
 */
export type AttendanceNotifyContext =
  | { context: "arrival" }
  | { context: "class"; classId: string; className: string }
  | { context: "departure" };

/**
 * 전송 제한 방식
 * - cooldown: 같은 키로 60초 안에 다시 보내지 않음(기간 결석 요약 알림)
 * - daily_change: 상태가 실제로 바뀐 알림 — 60초 쿨다운 없이, 서울 날짜별 최대 10회(정정이 막히지 않게)
 * 두 방식은 같은 키 문서의 다른 필드(`lastSentAt` / `changeDay`·`changeCount`)만 읽고 쓰므로 서로 막지 않는다(B5).
 */
export type AttendanceNotifyLimit = "cooldown" | "daily_change";

export type AttendanceNotifyOutcome =
  | { ok: true; sent: number; failureCount?: number; reason?: undefined }
  | {
      ok: true;
      sent: 0;
      /** muted = 학원 출결 설정에서 끈 종류(3-B ★9 — 알림 기록만, 벨·푸시 없음) */
      reason: "no_parent" | "parent_opt_out" | "no_token" | "cooldown" | "daily_limit" | "muted";
    };

export function rateLimitRef(
  db: admin.firestore.Firestore,
  academyId: string,
  studentId: string,
  ctx: AttendanceNotifyContext,
) {
  if (ctx.context === "class") {
    return db.doc(`_pushRateLimits/class_attendance_${academyId}_${ctx.classId}_${studentId}`);
  }
  if (ctx.context === "departure") return db.doc(`_pushRateLimits/departure_${academyId}_${studentId}`);
  return db.doc(`_pushRateLimits/attendance_${academyId}_${studentId}`);
}

export function attendanceSettingsRef(db: admin.firestore.Firestore, academyId: string) {
  return db.doc(`academies/${academyId}/meta/attendanceSettings`);
}

/** 학원 출결 설정 — 종류별 켜짐(문서가 없으면 모두 켬, B6) */
export async function loadNotifySettings(
  db: admin.firestore.Firestore,
  academyId: string,
): Promise<Record<AttendanceNotifyType, boolean>> {
  const snap = await attendanceSettingsRef(db, academyId).get();
  return readNotifySettings(snap.exists ? snap.get("notify") : undefined);
}

/** 전송 자격 확보 — 못 보내면 이유, 보내면 null */
async function claimSend(
  db: admin.firestore.Firestore,
  ref: FirebaseFirestore.DocumentReference,
  limit: AttendanceNotifyLimit,
  meta: Record<string, unknown>,
): Promise<"cooldown" | "daily_limit" | null> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    if (limit === "cooldown") {
      const last = (snap.get("lastSentAt") as Timestamp | undefined)?.toMillis() ?? 0;
      if (now - last < ATTENDANCE_COOLDOWN_MS) return "cooldown" as const;
      tx.set(ref, { ...meta, lastSentAt: FieldValue.serverTimestamp() }, { merge: true });
      return null;
    }
    const today = seoulDateString(new Date(now));
    const sameDay = snap.get("changeDay") === today;
    const count = sameDay && typeof snap.get("changeCount") === "number" ? (snap.get("changeCount") as number) : 0;
    if (count >= ATTENDANCE_DAILY_CHANGE_PUSH_LIMIT) return "daily_limit" as const;
    // 하루 횟수만 센다 — `lastSentAt`(기간 결석 60초 쿨다운)은 건드리지 않는다(B5: 서로 막지 않음)
    tx.set(ref, { ...meta, changeDay: today, changeCount: count + 1 }, { merge: true });
    return null;
  });
}

/** 벨 종류 — 학부모 벨 항목 `kind`(화면은 `body`만 씀) */
function bellKindFor(notify: AttendanceNotifyContext, kind: AttendanceNotifyKind): string {
  if (notify.context === "departure") return "departure";
  if (notify.context === "class") return kind === "late" ? "class_late" : kind === "absent" ? "class_absent" : "class_present";
  return kind === "absent" ? "attendance_absent" : "attendance_present";
}

/**
 * 학부모 알림 1건 — 알림 기록(`attendanceNotifications`) + 보호자별 벨 + 푸시.
 * 기록(등원·반 출결 문서)은 호출한 쪽이 먼저 저장한다. 전송 제한에 걸리면 기록 없이 이유만 돌려준다.
 * 3-B ★9: 받을 보호자가 있는데 학원 설정에서 끈 종류면 알림 기록(`muted: true`)만 남기고 벨·푸시·하루 횟수는 없다.
 */
export async function sendStudentAttendanceNotificationCore(
  db: admin.firestore.Firestore,
  params: {
    academyId: string;
    studentId: string;
    kind: AttendanceNotifyKind;
    sender: AttendanceSender;
    studentData: Record<string, unknown>;
    body: string;
    notify: AttendanceNotifyContext;
    limit: AttendanceNotifyLimit;
    /** 서울 기준 날짜(기록한 날) */
    date: string;
    /** 미등원 사유(`attendance-records.ts`의 AbsenceReason) — 알림 기록에 함께 저장 */
    reason?: string;
    /**
     * 2-J 기록 취소 정정 알림이면 "cancel" — 알림 기록·벨에 `action: "cancel"`(kind = 취소한 기록의 상태).
     * 없으면 기록 알림(예전 문서와 같음).
     */
    action?: "cancel";
    /** 취소 경로(기록용, 2-J) — 삭제된 문서 대신 알림 기록에 남김 */
    via?: string;
    /** 3-B 지각 분(반 맥락 late) */
    lateMinutes?: number | null;
    /** 3-B 기간 결석 요약 알림(다시 보내기에서 저장된 문구를 씀) */
    origin?: "absence_period";
    /** 3-B 다시 보내기 — 원래 알림 기록 id */
    resendOfId?: string;
  },
): Promise<AttendanceNotifyOutcome> {
  const { academyId, studentId, kind, sender, studentData, reason, body, notify, limit, date, action, via } = params;
  const actionFields = action ? { action } : {};

  const recipients = await resolveParentRecipients(db, academyId, studentData.parentUids);
  if (recipients.length === 0) {
    return { ok: true as const, sent: 0, reason: "no_parent" as const };
  }

  const notifyType = notifyTypeFor({ context: notify.context, kind, action: action ?? "record" });
  const muted = !(await loadNotifySettings(db, academyId))[notifyType];

  if (!muted) {
    const blocked = await claimSend(db, rateLimitRef(db, academyId, studentId, notify), limit, {
      actorUid: sender.actorUid,
      actorRole: sender.role,
      studentId,
      academyId,
      ...(notify.context === "class" ? { classId: notify.classId } : {}),
    });
    if (blocked) {
      return { ok: true as const, sent: 0, reason: blocked };
    }
  }

  const studentName =
    typeof studentData.name === "string" && studentData.name ? studentData.name : "학생";
  const contextFields =
    notify.context === "class"
      ? { context: "class" as const, classId: notify.classId, className: notify.className }
      : { context: notify.context };
  const lateFields = kind === "late" && params.lateMinutes ? { lateMinutes: params.lateMinutes } : {};

  const notifRef = await db.collection(`academies/${academyId}/attendanceNotifications`).add({
    kind,
    ...contextFields,
    ...actionFields,
    ...lateFields,
    ...(via ? { via } : {}),
    date,
    ...(reason ? { reason } : {}),
    ...(params.origin ? { origin: params.origin } : {}),
    ...(params.resendOfId ? { resend: true, resendOfId: params.resendOfId } : {}),
    ...(muted ? { muted: true } : {}),
    body,
    academyId,
    studentId,
    studentName,
    parentUids: recipients,
    senderRole: sender.role,
    senderUid: sender.actorUid,
    source: sender.source,
    createdAt: FieldValue.serverTimestamp(),
  });

  if (muted) return { ok: true as const, sent: 0, reason: "muted" as const };

  const bellKind = bellKindFor(notify, kind);

  // 연결된 활성 보호자마다 벨 + 푸시(전달 문서는 수신자별 — 재시도도 수신자별)
  const outcomes = await Promise.all(
    recipients.map(async (recipientUid) => {
      const userRef = db.doc(`users/${recipientUid}`);
      await userRef.collection("dashboardBellItems").add({
        kind: bellKind,
        ...contextFields,
        ...actionFields,
        ...lateFields,
        academyId,
        studentId,
        studentName,
        body,
        ...(reason ? { reason } : {}),
        senderRole: sender.role,
        senderUid: sender.actorUid,
        source: sender.source,
        createdAt: FieldValue.serverTimestamp(),
      });

      const userSnap = await userRef.get();
      if (!userSnap.exists || userSnap.get("pushNotificationsEnabled") !== true) {
        return { sent: 0, failureCount: 0, skip: "parent_opt_out" as const };
      }
      const subsSnap = await userRef.collection("pushSubscriptions").get();
      const hasToken = subsSnap.docs.some((d) => {
        const t = d.get("token");
        return typeof t === "string" && t.length > 20;
      });
      if (!hasToken) {
        return { sent: 0, failureCount: 0, skip: "no_token" as const };
      }

      const deliveryId = `${notifRef.id}_${recipientUid}`;
      await createAttendancePushDeliveryDoc(db, {
        deliveryId,
        academyId,
        studentId,
        recipientUid,
        kind,
        studentName,
        body,
      });
      const result = await deliverAttendancePushOnce(db, deliveryId, {
        allowScheduleRetries: true,
      });
      return { ...result, skip: null };
    }),
  ).catch((e) => {
    logger.error("sendStudentAttendanceNotificationCore", e);
    throw new HttpsError("internal", "알림 전송에 실패했습니다.");
  });

  const sent = outcomes.reduce((n, o) => n + o.sent, 0);
  const failureCount = outcomes.reduce((n, o) => n + o.failureCount, 0);
  if (sent === 0 && failureCount === 0) {
    // 아무에게도 보내지 못함 — 한 명이라도 기기가 없으면 no_token, 모두 꺼 두었으면 parent_opt_out
    const reasonOut = outcomes.some((o) => o.skip === "no_token") ? "no_token" : "parent_opt_out";
    return { ok: true as const, sent: 0, reason: reasonOut };
  }
  return { ok: true as const, sent, failureCount };
}
