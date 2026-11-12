import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  assertArrivalAccess,
  sendArrivalNotification,
  writeArrival,
} from "./attendance";
import { seoulDateString } from "./lib/attendance-rules";
import { pruneStalePushSubscriptions } from "./push-subscription-delivery";
import { actorHasPermission, resolveAcademyActor } from "./lib/academy-access";
import { readUidList } from "./lib/parent-recipients";

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
    // 끄기는 구독 정리만 — `users/{uid}`가 없으면 새로 만들지 않는다(2-N: 탈퇴 직후 아직 유효한 토큰의 로그아웃 정리가
    // 지운 사용자 문서를 다시 만들던 문제). 켜기는 그대로(문서를 만듦).
    const subs = await userRef.collection("pushSubscriptions").get();
    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      subs.docs.forEach((d) => tx.delete(d.ref));
      if (userSnap.exists) {
        tx.update(userRef, {
          pushNotificationsEnabled: false,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });
    await syncParentPushSummary(db, uid, false, 0);
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
  const tokenCount = (await userRef.collection("pushSubscriptions").count().get()).data().count;
  await syncParentPushSummary(db, uid, true, tokenCount);

  return { ok: true as const, pushNotificationsEnabled: true };
});

/**
 * 학부모 관리 화면용 푸시 수신 상태 — 소속 학원의 `parents/{uid}` 문서에 요약을 남긴다
 * (학원 직원은 학부모의 `users` 문서를 읽을 수 없음). 학부모 문서가 없으면(직원 계정 등) 아무것도 안 함.
 */
async function syncParentPushSummary(
  db: FirebaseFirestore.Firestore,
  uid: string,
  enabled: boolean,
  tokenCount: number,
): Promise<void> {
  const snaps = await db.collectionGroup("parents").where("authUid", "==", uid).limit(10).get();
  if (snaps.empty) return;
  const batch = db.batch();
  for (const d of snaps.docs) {
    batch.update(d.ref, {
      pushEnabled: enabled,
      pushTokenCount: tokenCount,
      pushSyncedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
}

/**
 * **예전 PWA 호환용(2-I) — 3단계 배포 때 삭제.** 2-I 이전 화면(선생님 출석·결석 버튼, 학생 상세 "출석 알림")이
 * 캐시된 채로 부를 수 있어 남긴다. 새 화면은 `recordStudentArrival`·`recordClassAttendance`를 쓴다.
 * - present → 등원(같은 상태면 그대로, 응답 reason "unchanged")
 * - absent → "기록 없음 → 미등원"만. 이미 등원한 날은 거부(예전 버튼의 결석 = 수업 결석이었음, B3)
 * 응답 형식은 예전 그대로 `{ ok, sent, reason? }`.
 */
export const sendStudentAttendanceNotification = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const studentId =
    typeof request.data?.studentId === "string" ? request.data.studentId.trim() : "";
  const kindRaw = request.data?.kind;
  const kind = kindRaw === "absent" ? "absent" : kindRaw === "present" ? "present" : "";
  if (!academyId || !studentId || academyId.includes("/") || studentId.includes("/") || !kind) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  const { studentData, sender } = await assertArrivalAccess(db, academyId, studentId, request.auth.uid);
  const date = seoulDateString();
  const result = await writeArrival(db, {
    academyId,
    studentId,
    status: kind,
    sender,
    via: "legacy",
    mode: "legacy",
    date,
  });
  if (!result.changed) {
    return { ok: true as const, sent: 0, reason: "unchanged" as const };
  }
  return sendArrivalNotification(db, { academyId, studentId, status: kind, sender, studentData, date });
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

  if (!isAdmin && !academyId) {
    throw new HttpsError("invalid-argument", "academyId가 필요합니다.");
  }

  let mode: "admin_all" | "academy_all" | "teacher_own";
  if (isAdmin && !academyId) {
    mode = "admin_all";
  } else if (isAdmin) {
    mode = "academy_all";
  } else {
    // 원장·포털·알림 기록 권한 직원은 학원 전체, 그 외 활성 직원은 본인 전송 기록만
    const actor = await resolveAcademyActor(db, academyId, uid);
    if (!actor) {
      throw new HttpsError("permission-denied", "알림 전송 기록을 조회할 권한이 없습니다.");
    }
    mode = actorHasPermission(actor, "lessons.notificationLog") ? "academy_all" : "teacher_own";
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
      context?: unknown;
      classId?: unknown;
      className?: unknown;
      action?: unknown;
      reason?: unknown;
      studentId?: unknown;
      studentName?: unknown;
      parentUids?: unknown;
      senderRole?: unknown;
      senderUid?: unknown;
      source?: unknown;
      createdAt?: unknown;
    };
    return {
      id: d.id,
      academyId: typeof x.academyId === "string" ? x.academyId : "",
      kind: (x.kind === "absent" ? "absent" : "present") as "present" | "absent",
      // 2-I 이전 기록은 context 없음 = 등원 맥락
      context: (x.context === "class" ? "class" : "arrival") as "arrival" | "class",
      classId: typeof x.classId === "string" ? x.classId : null,
      className: typeof x.className === "string" ? x.className : null,
      // 2-J 기록 취소 정정 알림 — 없는 문서는 기록 알림
      action: (x.action === "cancel" ? "cancel" : "record") as "record" | "cancel",
      reason: typeof x.reason === "string" ? x.reason : null,
      studentId: typeof x.studentId === "string" ? x.studentId : "",
      studentName: typeof x.studentName === "string" ? x.studentName : "",
      parentUids: readUidList(x.parentUids),
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
    for (const parentUid of item.academyId ? item.parentUids : []) {
      const key = `${item.academyId}:${parentUid}`;
      if (!parentKeySet.has(key)) {
        parentKeySet.add(key);
        parentKeys.push({ academyId: item.academyId, uid: parentUid });
      }
    }
  }

  const [teacherSnaps, ownerSnaps, parentSnaps] = await Promise.all([
    Promise.all(teacherKeys.map((k) => db.doc(`academies/${k.academyId}/staff/${k.uid}`).get())),
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
    // 받은 보호자 이름들(여러 명이면 쉼표로)
    const parentDisplayName =
      item.parentUids
        .map((uid) => parentNameMap.get(`${item.academyId}:${uid}`) ?? "학부모")
        .join(", ") || "학부모";
    return { ...item, senderDisplayName, parentDisplayName };
  });

  return { ok: true as const, items };
});
