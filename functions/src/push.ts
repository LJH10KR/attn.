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

type AttendanceSender = {
  role: "teacher" | "owner" | "academy";
  actorUid: string;
  source: "teacher_dashboard" | "academy_dashboard";
  canBypassCooldown: boolean;
};

async function resolveAttendanceSender(params: {
  db: FirebaseFirestore.Firestore;
  academyId: string;
  callerUid: string;
  token: admin.auth.DecodedIdToken;
  studentData: Record<string, unknown>;
}): Promise<AttendanceSender> {
  const { db, academyId, callerUid, token, studentData } = params;

  // 학원 포털 세션(custom token role=academy)
  if (token.role === "academy" && token.academyId === academyId) {
    return {
      role: "academy",
      actorUid: callerUid,
      source: "academy_dashboard",
      canBypassCooldown: false,
    };
  }

  // 활성 선생님 + 전담 학생 여부
  const teacherRef = db.doc(`academies/${academyId}/teachers/${callerUid}`);
  const teacherSnap = await teacherRef.get();
  if (teacherSnap.exists && teacherSnap.get("status") === "active") {
    if (!studentAssignedToTeacher(studentData, callerUid)) {
      throw new HttpsError("permission-denied", "전담 학생에게만 알림을 보낼 수 있습니다.");
    }
    return {
      role: "teacher",
      actorUid: callerUid,
      source: "teacher_dashboard",
      canBypassCooldown: true,
    };
  }

  // 오너(학원 문서 ownerUid)
  const academySnap = await db.doc(`academies/${academyId}`).get();
  if (academySnap.exists && academySnap.get("ownerUid") === callerUid) {
    return {
      role: "owner",
      actorUid: callerUid,
      source: "academy_dashboard",
      canBypassCooldown: false,
    };
  }

  throw new HttpsError("permission-denied", "출석/결석 알림을 보낼 권한이 없습니다.");
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
  const callerUid = request.auth.uid;
  const token = request.auth.token;
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
  const studentRef = db.doc(`academies/${academyId}/students/${studentId}`);
  const studentSnap = await studentRef.get();
  if (!studentSnap.exists) {
    throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
  }
  const studentData = studentSnap.data() as Record<string, unknown>;
  const sender = await resolveAttendanceSender({
    db,
    academyId,
    callerUid,
    token,
    studentData,
  });

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

  const studentName = typeof studentData.name === "string" && studentData.name ? studentData.name : "학생";
  const body =
    kind === "present" ? `${studentName} 학생이 출석했습니다.` : `${studentName} 학생이 결석 처리되었습니다.`;

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

  const subsSnap = await parentUserRef.collection("pushSubscriptions").get();
  const tokens = subsSnap.docs
    .map((d) => d.get("token"))
    .filter((t): t is string => typeof t === "string" && t.length > 20);
  if (tokens.length === 0) {
    return { ok: true as const, sent: 0, reason: "no_token" as const };
  }

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
    }

    /**
     * 무효 토큰만 정리하고 `pushNotificationsEnabled`는 건드리지 않습니다.
     * PWA 재실행·SW 교체 직후에는 Firestore에 예전 토큰만 남은 채로 푸시가 먼저 도착할 수 있어,
     * 전부 무효 처리되면 사용자가 설정에서 켜 둔 상태가 서버에서 꺼짐으로 바뀌는 문제가 생깁니다.
     * 새 토큰은 클라이언트(`resyncParentPushTokenAfterResume` 등)가 다시 올립니다.
     */

    return { ok: true as const, sent: resp.successCount, failureCount: resp.failureCount };
  } catch (e) {
    logger.error("sendStudentAttendanceNotification", e);
    throw new HttpsError("internal", "알림 전송에 실패했습니다.");
  }
});

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * 출석/결석 알림 전송 기록 조회
 * - admin: academyId 없이 전체 최근 기록 가능(collectionGroup)
 * - owner/academy: 해당 academyId 전체 기록 조회 가능
 * - teacher: 본인(senderUid==uid) 전송 기록만 조회 가능
 */
export const listAttendanceNotifications = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const limit = clampInt(request.data?.limit, 40, 1, 100);

  const db = admin.firestore();
  const isAdmin = Boolean(token && (token as Record<string, unknown>).admin === true);
  const isAcademyPortal = token.role === "academy";

  if (!isAdmin && !academyId) {
    throw new HttpsError("invalid-argument", "academyId가 필요합니다.");
  }

  let mode: "admin_all" | "academy_all" | "teacher_own";
  if (isAdmin && !academyId) {
    mode = "admin_all";
  } else if (isAcademyPortal) {
    if (!academyId || token.academyId !== academyId) {
      throw new HttpsError("permission-denied", "해당 학원 기록을 조회할 권한이 없습니다.");
    }
    mode = "academy_all";
  } else {
    const academySnap = await db.doc(`academies/${academyId}`).get();
    const ownerUid = academySnap.exists ? academySnap.get("ownerUid") : null;
    if (ownerUid === uid || isAdmin) {
      mode = "academy_all";
    } else {
      const teacherSnap = await db.doc(`academies/${academyId}/teachers/${uid}`).get();
      if (!teacherSnap.exists || teacherSnap.get("status") !== "active") {
        throw new HttpsError("permission-denied", "알림 전송 기록을 조회할 권한이 없습니다.");
      }
      mode = "teacher_own";
    }
  }

  const snaps =
    mode === "admin_all"
      ? await db.collectionGroup("attendanceNotifications").orderBy("createdAt", "desc").limit(limit).get()
      : mode === "teacher_own"
        ? await db
          .collection(`academies/${academyId}/attendanceNotifications`)
          .where("senderUid", "==", uid)
          .orderBy("createdAt", "desc")
          .limit(limit)
          .get()
        : await db.collection(`academies/${academyId}/attendanceNotifications`).orderBy("createdAt", "desc").limit(limit).get();

  return {
    ok: true as const,
    items: snaps.docs.map((d) => {
      const x = d.data() as {
        academyId?: unknown;
        kind?: unknown;
        studentId?: unknown;
        studentName?: unknown;
        parentUserId?: unknown;
        senderRole?: unknown;
        senderUid?: unknown;
        source?: unknown;
        createdAt?: unknown;
      };
      return {
        id: d.id,
        academyId: typeof x.academyId === "string" ? x.academyId : "",
        kind: x.kind === "absent" ? "absent" : "present",
        studentId: typeof x.studentId === "string" ? x.studentId : "",
        studentName: typeof x.studentName === "string" ? x.studentName : "",
        parentUserId: typeof x.parentUserId === "string" ? x.parentUserId : "",
        senderRole: typeof x.senderRole === "string" ? x.senderRole : "",
        senderUid: typeof x.senderUid === "string" ? x.senderUid : "",
        source: typeof x.source === "string" ? x.source : "",
        createdAtMillis:
          x.createdAt && typeof (x.createdAt as { toMillis?: unknown }).toMillis === "function"
            ? (x.createdAt as { toMillis: () => number }).toMillis()
            : null,
      };
    }),
  };
});
