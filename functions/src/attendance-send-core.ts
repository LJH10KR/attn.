import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import {
  createAttendancePushDeliveryDoc,
  deliverAttendancePushOnce,
} from "./attendance-push-delivery";

export const ATTENDANCE_COOLDOWN_MS = 60_000;

const TEMP_TEACHER_ATTENDANCE_COOLDOWN_BYPASS_PER_UTC_DAY = 10;

function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatRequestedTimeLabel(date: Date): string {
  try {
    const hhmm = new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
    return `요청 시각 ${hhmm}`;
  } catch {
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `요청 시각 ${hh}:${mm}`;
  }
}

export type AttendanceSender = {
  role: "teacher" | "owner" | "academy" | "student_kiosk";
  actorUid: string;
  source: "teacher_dashboard" | "academy_dashboard" | "student_kiosk";
  canBypassCooldown: boolean;
};

export async function sendStudentAttendanceNotificationCore(
  db: admin.firestore.Firestore,
  params: {
    academyId: string;
    studentId: string;
    kind: "present" | "absent";
    sender: AttendanceSender;
    studentData: Record<string, unknown>;
  },
): Promise<
  | { ok: true; sent: number; failureCount?: number; reason?: undefined }
  | { ok: true; sent: 0; reason: "no_parent" | "parent_opt_out" | "no_token" }
> {
  const { academyId, studentId, kind, sender, studentData } = params;

  const parentUserId = studentData.parentUserId;
  if (typeof parentUserId !== "string" || !parentUserId) {
    return { ok: true as const, sent: 0, reason: "no_parent" as const };
  }

  const parentUserRef = db.doc(`users/${parentUserId}`);
  const rateRef = db.doc(`_pushRateLimits/attendance_${academyId}_${studentId}`);
  const dayKey = utcDayKey();
  const cooldownBypassRef =
    sender.canBypassCooldown && TEMP_TEACHER_ATTENDANCE_COOLDOWN_BYPASS_PER_UTC_DAY > 0
      ? db.doc(
        `_pushRateLimits/attendance_cooldown_bypass_${academyId}_${sender.actorUid}_${dayKey}`,
      )
      : null;

  await db.runTransaction(async (tx) => {
    const rateSnap = await tx.get(rateRef);
    const lastMillis = rateSnap.exists
      ? (rateSnap.get("lastSentAt") as Timestamp | undefined)?.toMillis() ?? 0
      : 0;
    const now = Date.now();
    const tooSoon = now - lastMillis < ATTENDANCE_COOLDOWN_MS;

    if (tooSoon) {
      if (!cooldownBypassRef || TEMP_TEACHER_ATTENDANCE_COOLDOWN_BYPASS_PER_UTC_DAY <= 0) {
        throw new HttpsError(
          "resource-exhausted",
          "같은 학생에게 알림을 너무 자주 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.",
        );
      }
      const bypassSnap = await tx.get(cooldownBypassRef);
      const used =
        bypassSnap.exists && typeof bypassSnap.get("used") === "number"
          ? (bypassSnap.get("used") as number)
          : 0;
      if (used >= TEMP_TEACHER_ATTENDANCE_COOLDOWN_BYPASS_PER_UTC_DAY) {
        throw new HttpsError(
          "resource-exhausted",
          "같은 학생에게 알림을 너무 자주 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.",
        );
      }
      tx.set(
        cooldownBypassRef,
        {
          used: FieldValue.increment(1),
          actorUid: sender.actorUid,
          actorRole: sender.role,
          academyId,
          dayKey,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    tx.set(
      rateRef,
      {
        lastSentAt: FieldValue.serverTimestamp(),
        actorUid: sender.actorUid,
        actorRole: sender.role,
        studentId,
        academyId,
      },
      { merge: true },
    );
  });

  const studentName =
    typeof studentData.name === "string" && studentData.name ? studentData.name : "학생";
  const requestedAtLabel = formatRequestedTimeLabel(new Date());
  const body =
    kind === "present"
      ? `${studentName} 학생이 출석했습니다. (${requestedAtLabel})`
      : `${studentName} 학생이 결석 처리되었습니다. (${requestedAtLabel})`;

  await parentUserRef.collection("dashboardBellItems").add({
    kind: kind === "present" ? "attendance_present" : "attendance_absent",
    academyId,
    studentId,
    studentName,
    body,
    senderRole: sender.role,
    senderUid: sender.actorUid,
    source: sender.source,
    createdAt: FieldValue.serverTimestamp(),
  });

  const notifRef = await db.collection(`academies/${academyId}/attendanceNotifications`).add({
    kind,
    academyId,
    studentId,
    studentName,
    parentUserId,
    senderRole: sender.role,
    senderUid: sender.actorUid,
    source: sender.source,
    createdAt: FieldValue.serverTimestamp(),
  });

  const userSnap = await parentUserRef.get();
  if (!userSnap.exists || userSnap.get("pushNotificationsEnabled") !== true) {
    return { ok: true as const, sent: 0, reason: "parent_opt_out" as const };
  }

  const subsSnap = await parentUserRef.collection("pushSubscriptions").get();
  const hasToken = subsSnap.docs.some((d) => {
    const t = d.get("token");
    return typeof t === "string" && t.length > 20;
  });
  if (!hasToken) {
    return { ok: true as const, sent: 0, reason: "no_token" as const };
  }

  const deliveryId = notifRef.id;
  await createAttendancePushDeliveryDoc(db, {
    deliveryId,
    academyId,
    studentId,
    parentUserId,
    kind,
    studentName,
    body,
  });

  try {
    const { sent, failureCount } = await deliverAttendancePushOnce(db, deliveryId, {
      allowScheduleRetries: true,
    });
    return { ok: true as const, sent, failureCount };
  } catch (e) {
    logger.error("sendStudentAttendanceNotificationCore", e);
    throw new HttpsError("internal", "알림 전송에 실패했습니다.");
  }
}
