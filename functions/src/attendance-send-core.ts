import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { countUserDashboardBellItems } from "./app-badge-count";
import {
  applyMulticastDeliveryResults,
  type PushTokenBucket,
} from "./push-subscription-delivery";

export const ATTENDANCE_COOLDOWN_MS = 60_000;

const TEMP_TEACHER_ATTENDANCE_COOLDOWN_BYPASS_PER_UTC_DAY = 10;

function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10);
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
  const body =
    kind === "present"
      ? `${studentName} 학생이 출석했습니다.`
      : `${studentName} 학생이 결석 처리되었습니다.`;

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

  await db.collection(`academies/${academyId}/attendanceNotifications`).add({
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

  const userLastSyncedAt = userSnap.get("pushSubscriptionLastSyncedAt") as Timestamp | undefined;

  const subsSnap = await parentUserRef.collection("pushSubscriptions").get();
  const buckets: PushTokenBucket[] = [];
  const indexByToken = new Map<string, number>();
  for (const d of subsSnap.docs) {
    const t = d.get("token");
    if (typeof t !== "string" || t.length <= 20) continue;
    const updatedAt = d.get("updatedAt") as Timestamp | undefined;
    const millis = updatedAt?.toMillis() ?? 0;
    const invalidDeliveryCount =
      typeof d.get("invalidDeliveryCount") === "number"
        ? (d.get("invalidDeliveryCount") as number)
        : 0;
    const existing = indexByToken.get(t);
    if (existing !== undefined) {
      buckets[existing]!.refs.push(d.ref);
      buckets[existing]!.invalidCounts.push(invalidDeliveryCount);
      buckets[existing]!.updatedAtMillis = Math.max(buckets[existing]!.updatedAtMillis, millis);
    } else {
      indexByToken.set(t, buckets.length);
      buckets.push({
        token: t,
        refs: [d.ref],
        updatedAtMillis: millis,
        invalidCounts: [invalidDeliveryCount],
      });
    }
  }
  const tokens = buckets.map((b) => b.token);

  if (tokens.length === 0) {
    return { ok: true as const, sent: 0, reason: "no_token" as const };
  }

  const appBadgeCount = await countUserDashboardBellItems(db, parentUserId);

  const dataPayload: Record<string, string> = {
    title: "attn.",
    body,
    type: "attendance",
    status: kind,
    studentId,
    studentName,
    academyId,
    parentUserId,
    appBadgeCount: String(appBadgeCount),
  };

  try {
    const resp = await admin.messaging().sendEachForMulticast({
      tokens,
      data: dataPayload,
    });
    if (resp.failureCount > 0) {
      logger.warn("sendStudentAttendanceNotification partial failure", {
        success: resp.successCount,
        failure: resp.failureCount,
        parentUserId,
      });
    }

    await applyMulticastDeliveryResults({
      db,
      parentUserId,
      userLastSyncedAt,
      buckets,
      responses: resp.responses,
      logContext: "sendStudentAttendanceNotification",
    });

    return { ok: true as const, sent: resp.successCount, failureCount: resp.failureCount };
  } catch (e) {
    logger.error("sendStudentAttendanceNotificationCore", e);
    throw new HttpsError("internal", "알림 전송에 실패했습니다.");
  }
}
