import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp, type DocumentReference } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

const ATTENDANCE_COOLDOWN_MS = 60_000;

/**
 * 푸시 QA용(일시): 선생님당 UTC 일 기준으로, 같은 학생에 대한 60초 쿨다운을 추가로 무시하고
 * 보낼 수 있는 횟수. 운영 안정화 후 `0`으로 두면 쿨다운만 적용됩니다.
 */
const TEMP_TEACHER_ATTENDANCE_COOLDOWN_BYPASS_PER_UTC_DAY = 10;

function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** FCM이 해당 토큰을 더 이상 유효하지 않다고 판단할 때 — Firestore 구독 문서 정리 */
const FCM_TOKEN_INVALID_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

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
  const dayKey = utcDayKey();
  const cooldownBypassRef =
    TEMP_TEACHER_ATTENDANCE_COOLDOWN_BYPASS_PER_UTC_DAY > 0
      ? db.doc(
        `_pushRateLimits/attendance_cooldown_bypass_${academyId}_${teacherUid}_${dayKey}`,
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
      if (
        !cooldownBypassRef ||
        TEMP_TEACHER_ATTENDANCE_COOLDOWN_BYPASS_PER_UTC_DAY <= 0
      ) {
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
          teacherUid,
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
        teacherUid,
        studentId,
        academyId,
      },
      { merge: true },
    );
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

    const deadRefs: DocumentReference[] = [];
    for (let i = 0; i < resp.responses.length; i++) {
      const r = resp.responses[i];
      if (r.success) continue;
      const code = r.error?.code ?? "";
      if (!FCM_TOKEN_INVALID_CODES.has(code)) continue;
      const bad = tokens[i];
      const docMatch = subsSnap.docs.find((d) => d.get("token") === bad);
      if (docMatch) deadRefs.push(docMatch.ref);
    }
    if (deadRefs.length > 0) {
      let batch = db.batch();
      let n = 0;
      for (const ref of deadRefs) {
        batch.delete(ref);
        n++;
        if (n >= 450) {
          await batch.commit();
          batch = db.batch();
          n = 0;
        }
      }
      if (n > 0) await batch.commit();
      const anyLeft = await userRef.collection("pushSubscriptions").limit(1).get();
      if (anyLeft.empty) {
        await userRef.set(
          {
            pushNotificationsEnabled: false,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
    }

    return { ok: true as const, sent: resp.successCount, failureCount: resp.failureCount };
  } catch (e) {
    logger.error("sendStudentAttendanceNotification", e);
    throw new HttpsError("internal", "알림 전송에 실패했습니다.");
  }
});
