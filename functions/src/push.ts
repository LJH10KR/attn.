import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { sendStudentAttendanceNotificationCore } from "./attendance-send-core";
import { pruneStalePushSubscriptions } from "./push-subscription-delivery";

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
 *
 * 기기 정책: 최근 동기화 토큰을 우선하되, 롤오버·재실행 직후 구간을 위해 최대 3개까지 병행 유지합니다.
 * 오래된 구독(7일+)만 sync 시 정리합니다.
 */
export const syncParentPushSubscription = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const uid = request.auth.uid;
  const enabled = Boolean(request.data?.enabled);
  const fcmTokenRaw = request.data?.fcmToken;
  const fcmToken = typeof fcmTokenRaw === "string" ? fcmTokenRaw.trim() : "";
  const clientAtMillisRaw = request.data?.clientAtMillis;
  const clientAtMillis =
    typeof clientAtMillisRaw === "number" && Number.isFinite(clientAtMillisRaw)
      ? Math.floor(clientAtMillisRaw)
      : undefined;
  const syncModeRaw = request.data?.syncMode;
  const syncMode = syncModeRaw === "force_rotate" ? "force_rotate" : "normal";
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

  const batch = db.batch();
  batch.set(subRef, {
    token: fcmToken,
    platform: "web",
    updatedAt: FieldValue.serverTimestamp(),
    invalidDeliveryCount: 0,
  });
  const tokenHash = crypto.createHash("sha256").update(fcmToken).digest("hex").slice(0, 16);
  batch.set(
    userRef,
    {
      pushNotificationsEnabled: true,
      pushSubscriptionLastSyncedAt: FieldValue.serverTimestamp(),
      pushLastSyncServerAt: FieldValue.serverTimestamp(),
      pushLastSyncClientAtMillis: clientAtMillis ?? null,
      pushLastSyncMode: syncMode,
      pushLastSyncResult: "ok",
      pushLastSyncTokenHash: tokenHash,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await batch.commit();
  await pruneStalePushSubscriptions(userRef, subId);

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

  return sendStudentAttendanceNotificationCore(db, {
    academyId,
    studentId,
    kind,
    sender,
    studentData,
  });
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

  // 1단계: 원본 데이터 직렬화
  const rawItems = snaps.docs.map((d) => {
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
      kind: (x.kind === "absent" ? "absent" : "present") as "present" | "absent",
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
  });

  // 2단계: display name 배치 조회 — 중복 제거 후 병렬 fetch
  const teacherKeys: { academyId: string; uid: string }[] = [];
  const ownerKeys: string[] = [];
  const parentKeys: { academyId: string; uid: string }[] = [];
  const teacherKeySet = new Set<string>();
  const ownerKeySet = new Set<string>();
  const parentKeySet = new Set<string>();

  for (const item of rawItems) {
    const isKiosk = item.source === "student_kiosk" || item.senderRole === "student_kiosk";
    if (!isKiosk && item.senderUid && item.academyId) {
      if (item.senderRole === "teacher") {
        const key = `${item.academyId}:${item.senderUid}`;
        if (!teacherKeySet.has(key)) {
          teacherKeySet.add(key);
          teacherKeys.push({ academyId: item.academyId, uid: item.senderUid });
        }
      } else if (item.senderRole === "owner") {
        if (!ownerKeySet.has(item.senderUid)) {
          ownerKeySet.add(item.senderUid);
          ownerKeys.push(item.senderUid);
        }
      }
    }
    if (item.parentUserId && item.academyId) {
      const key = `${item.academyId}:${item.parentUserId}`;
      if (!parentKeySet.has(key)) {
        parentKeySet.add(key);
        parentKeys.push({ academyId: item.academyId, uid: item.parentUserId });
      }
    }
  }

  const [teacherSnaps, ownerSnaps, parentSnaps] = await Promise.all([
    Promise.all(teacherKeys.map((k) => db.doc(`academies/${k.academyId}/teachers/${k.uid}`).get())),
    Promise.all(ownerKeys.map((uid) => db.doc(`users/${uid}`).get())),
    Promise.all(parentKeys.map((k) => db.doc(`academies/${k.academyId}/parents/${k.uid}`).get())),
  ]);

  const teacherNameMap = new Map<string, string>();
  teacherKeys.forEach((k, i) => {
    const name = teacherSnaps[i]?.get("displayName");
    if (typeof name === "string" && name) teacherNameMap.set(`${k.academyId}:${k.uid}`, name);
  });
  const ownerNameMap = new Map<string, string>();
  ownerKeys.forEach((uid, i) => {
    const name = ownerSnaps[i]?.get("displayName");
    if (typeof name === "string" && name) ownerNameMap.set(uid, name);
  });
  const parentNameMap = new Map<string, string>();
  parentKeys.forEach((k, i) => {
    const name = parentSnaps[i]?.get("displayName");
    if (typeof name === "string" && name) parentNameMap.set(`${k.academyId}:${k.uid}`, name);
  });

  // 3단계: display name 합성
  const items = rawItems.map((item) => {
    let senderDisplayName: string;
    if (item.source === "student_kiosk" || item.senderRole === "student_kiosk") {
      senderDisplayName = "키오스크";
    } else if (item.senderRole === "teacher") {
      senderDisplayName = teacherNameMap.get(`${item.academyId}:${item.senderUid}`) ?? "선생님";
    } else if (item.senderRole === "owner") {
      senderDisplayName = ownerNameMap.get(item.senderUid) ?? "오너";
    } else if (item.senderRole === "academy") {
      senderDisplayName = "학원";
    } else {
      senderDisplayName = item.senderRole || "알 수 없음";
    }
    const parentDisplayName =
      parentNameMap.get(`${item.academyId}:${item.parentUserId}`) ?? "학부모";
    return { ...item, senderDisplayName, parentDisplayName };
  });

  return { ok: true as const, items };
});
