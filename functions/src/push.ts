import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

const ATTENDANCE_COOLDOWN_MS = 60_000;

function studentAssignedToTeacher(data: Record<string, unknown>, teacherUid: string): boolean {
  const raw = data.assignedTeacherUids;
  const fromList =
    Array.isArray(raw) && raw.every((x: unknown) => typeof x === "string")
      ? (raw as string[]).filter((x) => x.length > 0)
      : [];
  if (fromList.includes(teacherUid)) return true;
  const legacy = data.assignedTeacherUid;
  return typeof legacy === "string" && legacy.length > 0 && legacy === teacherUid;
}

/**
 * 학부모 푸시 구독 동기화 — 토큰 저장/삭제는 Admin만 수행해 클라이언트 규칙과 무관하게 일관되게 유지합니다.
 */
export const syncParentPushSubscription = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const uid = request.auth.uid;
  const enabled = Boolean(request.data?.enabled);
  const fcmTokenRaw = request.data?.fcmToken;
  const fcmToken = typeof fcmTokenRaw === "string" ? fcmTokenRaw.trim() : "";
  if (enabled && (!fcmToken || fcmToken.length < 80)) {
    throw new HttpsError("invalid-argument", "유효한 FCM 토큰이 필요합니다.");
  }

  const db = admin.firestore();
  const userRef = db.doc(`users/${uid}`);

  if (!enabled) {
    const subs = await userRef.collection("pushSubscriptions").get();
    const batch = db.batch();
    subs.docs.forEach((d) => batch.delete(d.ref));
    batch.set(
      userRef,
      {
        pushNotificationsEnabled: false,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    await batch.commit();
    return { ok: true as const, pushNotificationsEnabled: false };
  }

  const subId = crypto.createHash("sha256").update(fcmToken).digest("hex").slice(0, 48);
  const subRef = userRef.collection("pushSubscriptions").doc(subId);
  await subRef.set({
    token: fcmToken,
    platform: "web",
    updatedAt: FieldValue.serverTimestamp(),
  });
  await userRef.set(
    {
      pushNotificationsEnabled: true,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { ok: true as const, pushNotificationsEnabled: true };
});

/**
 * 전담 선생님이 학부모에게 출석/결석 알림(FCM data 메시지)을 보냅니다.
 */
export const sendStudentAttendanceNotification = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const teacherUid = request.auth.uid;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const studentId =
    typeof request.data?.studentId === "string" ? request.data.studentId.trim() : "";
  const kindRaw = request.data?.kind;
  const kind = kindRaw === "absent" ? "absent" : kindRaw === "present" ? "present" : "";
  if (!academyId || !studentId || !kind) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  const teacherRef = db.doc(`academies/${academyId}/teachers/${teacherUid}`);
  const teacherSnap = await teacherRef.get();
  if (!teacherSnap.exists || teacherSnap.get("status") !== "active") {
    throw new HttpsError("permission-denied", "활성 선생님만 알림을 보낼 수 있습니다.");
  }

  const studentRef = db.doc(`academies/${academyId}/students/${studentId}`);
  const studentSnap = await studentRef.get();
  if (!studentSnap.exists) {
    throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
  }
  const studentData = studentSnap.data() as Record<string, unknown>;
  if (!studentAssignedToTeacher(studentData, teacherUid)) {
    throw new HttpsError("permission-denied", "전담 학생에게만 알림을 보낼 수 있습니다.");
  }

  const parentUserId = studentData.parentUserId;
  if (typeof parentUserId !== "string" || !parentUserId) {
    return { ok: true as const, sent: 0, reason: "no_parent" as const };
  }

  const userRef = db.doc(`users/${parentUserId}`);
  const userSnap = await userRef.get();
  if (!userSnap.exists || userSnap.get("pushNotificationsEnabled") !== true) {
    return { ok: true as const, sent: 0, reason: "parent_opt_out" as const };
  }

  const subsSnap = await userRef.collection("pushSubscriptions").get();
  const tokens = subsSnap.docs
    .map((d) => d.get("token"))
    .filter((t): t is string => typeof t === "string" && t.length > 20);
  if (tokens.length === 0) {
    return { ok: true as const, sent: 0, reason: "no_token" as const };
  }

  const rateRef = db.doc(`_pushRateLimits/attendance_${academyId}_${studentId}`);
  await db.runTransaction(async (tx) => {
    const rateSnap = await tx.get(rateRef);
    const lastMillis = rateSnap.exists ? (rateSnap.get("lastSentAt") as Timestamp | undefined)?.toMillis() ?? 0 : 0;
    const now = Date.now();
    if (now - lastMillis < ATTENDANCE_COOLDOWN_MS) {
      throw new HttpsError("resource-exhausted", "같은 학생에게 알림을 너무 자주 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.");
    }
    tx.set(rateRef, { lastSentAt: FieldValue.serverTimestamp(), teacherUid, studentId, academyId }, { merge: true });
  });

  const studentName = typeof studentData.name === "string" && studentData.name ? studentData.name : "학생";
  const body =
    kind === "present" ? `${studentName} 학생이 출석했습니다.` : `${studentName} 학생이 결석 처리되었습니다.`;

  const dataPayload: Record<string, string> = {
    title: "attn.",
    body,
    type: "attendance",
    status: kind,
    studentId,
    studentName,
    academyId,
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
      });
    }
    return { ok: true as const, sent: resp.successCount, failureCount: resp.failureCount };
  } catch (e) {
    logger.error("sendStudentAttendanceNotification", e);
    throw new HttpsError("internal", "알림 전송에 실패했습니다.");
  }
});
