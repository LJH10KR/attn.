import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFunctions } from "firebase-admin/functions";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import * as logger from "firebase-functions/logger";
import { countUserDashboardBellItems } from "./app-badge-count";
import {
  applyMulticastDeliveryResults,
  FCM_TOKEN_INVALID_CODES,
  PUSH_INVALID_DELETE_GRACE_MS,
  type PushTokenBucket,
} from "./push-subscription-delivery";

const REGION = "asia-northeast3";
const RETRY_TASK_FUNCTION = "retryAttendancePushDelivery";

/** 초기 1회 + 지연 재전송 최대 2회 */
export const PUSH_DELIVERY_MAX_FCM_ATTEMPTS = 3;

/** 예약 가능한 지연 재전송 횟수 (비용 상한) */
const PUSH_DELIVERY_MAX_RETRY_TASKS = 2;

const PUSH_DELIVERY_RETRY_DELAYS_SEC = [45, 120] as const;

/** delivery 문서 보관 (자동 정리용) */
const PUSH_DELIVERY_DOC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type AttendancePushDeliveryDoc = {
  deliveryId: string;
  academyId: string;
  studentId: string;
  parentUserId: string;
  kind: "present" | "absent";
  studentName: string;
  body: string;
  pushDelivered: boolean;
  fcmAttempts: number;
  retriesScheduled: number;
  createdAt: FirebaseFirestore.FieldValue;
  expiresAt: Timestamp;
};

export function parentPushLastSyncMillis(
  userData: FirebaseFirestore.DocumentData | undefined,
): number {
  if (!userData) return 0;
  const serverAt = userData.pushLastSyncServerAt as Timestamp | undefined;
  const legacyAt = userData.pushSubscriptionLastSyncedAt as Timestamp | undefined;
  return Math.max(serverAt?.toMillis() ?? 0, legacyAt?.toMillis() ?? 0);
}

export function isRecentParentPushSync(userData: FirebaseFirestore.DocumentData | undefined): boolean {
  const ms = parentPushLastSyncMillis(userData);
  if (ms <= 0) return false;
  return Date.now() - ms <= PUSH_INVALID_DELETE_GRACE_MS;
}

function loadPushBuckets(
  subsSnap: FirebaseFirestore.QuerySnapshot,
): PushTokenBucket[] {
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
  return buckets;
}

function wasGraceInvalidOnlyFailure(params: {
  buckets: PushTokenBucket[];
  responses: admin.messaging.SendResponse[];
  userLastSyncedAt?: Timestamp;
}): boolean {
  const { buckets, responses, userLastSyncedAt } = params;
  const now = Date.now();
  let hadGraceInvalid = false;
  let hadOtherFailure = false;

  for (let i = 0; i < responses.length; i++) {
    const r = responses[i];
    if (r.success) continue;
    const bucket = buckets[i];
    if (!bucket) continue;
    const code = r.error?.code ?? "";
    if (!FCM_TOKEN_INVALID_CODES.has(code)) {
      hadOtherFailure = true;
      continue;
    }
    const userMs = userLastSyncedAt?.toMillis() ?? 0;
    const graceUntil = Math.max(userMs, bucket.updatedAtMillis) + PUSH_INVALID_DELETE_GRACE_MS;
    if (now < graceUntil) {
      hadGraceInvalid = true;
    } else {
      hadOtherFailure = true;
    }
  }

  return hadGraceInvalid && !hadOtherFailure;
}

/**
 * 출석 푸시 1회 전송. 재시도 Task에서는 추가 예약을 하지 않습니다(무한 루프 방지).
 */
export async function deliverAttendancePushOnce(
  db: admin.firestore.Firestore,
  deliveryId: string,
  opts: { allowScheduleRetries: boolean },
): Promise<{ sent: number; failureCount: number }> {
  const deliveryRef = db.doc(`_pushDeliveries/${deliveryId}`);
  const deliverySnap = await deliveryRef.get();
  if (!deliverySnap.exists) {
    logger.warn("deliverAttendancePushOnce missing delivery doc", { deliveryId });
    return { sent: 0, failureCount: 0 };
  }

  const delivery = deliverySnap.data() as AttendancePushDeliveryDoc;
  if (delivery.pushDelivered === true) {
    return { sent: 1, failureCount: 0 };
  }

  const expiresAt = delivery.expiresAt as Timestamp | undefined;
  if (expiresAt && expiresAt.toMillis() < Date.now()) {
    logger.warn("deliverAttendancePushOnce expired", { deliveryId });
    return { sent: 0, failureCount: 0 };
  }

  const attemptClaim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(deliveryRef);
    if (!snap.exists) return { proceed: false as const };
    const d = snap.data() as AttendancePushDeliveryDoc;
    if (d.pushDelivered === true) return { proceed: false as const };
    const attempts = typeof d.fcmAttempts === "number" ? d.fcmAttempts : 0;
    if (attempts >= PUSH_DELIVERY_MAX_FCM_ATTEMPTS) {
      return { proceed: false as const };
    }
    tx.update(deliveryRef, { fcmAttempts: attempts + 1 });
    return { proceed: true as const, delivery: d, attempts: attempts + 1 };
  });

  if (!attemptClaim.proceed) {
    return { sent: 0, failureCount: 0 };
  }

  const {
    parentUserId,
    academyId,
    studentId,
    kind,
    studentName,
    body,
  } = attemptClaim.delivery;

  const parentUserRef = db.doc(`users/${parentUserId}`);
  const userSnap = await parentUserRef.get();
  if (!userSnap.exists || userSnap.get("pushNotificationsEnabled") !== true) {
    return { sent: 0, failureCount: 0 };
  }

  const userData = userSnap.data();
  const userLastSyncedAt =
    (userData?.pushLastSyncServerAt as Timestamp | undefined) ??
    (userData?.pushSubscriptionLastSyncedAt as Timestamp | undefined);

  const subsSnap = await parentUserRef.collection("pushSubscriptions").get();
  const buckets = loadPushBuckets(subsSnap);
  const tokens = buckets.map((b) => b.token);
  if (tokens.length === 0) {
    return { sent: 0, failureCount: 0 };
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
    deliveryId,
  };

  const resp = await admin.messaging().sendEachForMulticast({
    tokens,
    data: dataPayload,
  });

  if (resp.failureCount > 0) {
    logger.warn("deliverAttendancePushOnce partial failure", {
      deliveryId,
      parentUserId,
      success: resp.successCount,
      failure: resp.failureCount,
      fcmAttempt: attemptClaim.attempts,
      allowScheduleRetries: opts.allowScheduleRetries,
    });
  }

  const { skippedGraceCount } = await applyMulticastDeliveryResults({
    db,
    parentUserId,
    userLastSyncedAt,
    buckets,
    responses: resp.responses,
    logContext: opts.allowScheduleRetries
      ? "sendStudentAttendanceNotification"
      : "retryAttendancePushDelivery",
  });

  if (resp.successCount > 0) {
    await deliveryRef.set(
      {
        pushDelivered: true,
        deliveredAt: FieldValue.serverTimestamp(),
        lastFcmSuccessCount: resp.successCount,
      },
      { merge: true },
    );
    return { sent: resp.successCount, failureCount: resp.failureCount };
  }

  if (
    opts.allowScheduleRetries &&
    resp.successCount === 0 &&
    resp.failureCount > 0 &&
    skippedGraceCount > 0 &&
    isRecentParentPushSync(userData) &&
    wasGraceInvalidOnlyFailure({ buckets, responses: resp.responses, userLastSyncedAt })
  ) {
    await maybeScheduleAttendancePushRetries(db, deliveryId, parentUserId);
  }

  return { sent: resp.successCount, failureCount: resp.failureCount };
}

/**
 * 지연 재전송 예약 — delivery당 최대 1회만(2개 Task). Task id로 중복 enqueue 방지.
 */
async function maybeScheduleAttendancePushRetries(
  db: admin.firestore.Firestore,
  deliveryId: string,
  parentUserId: string,
): Promise<void> {
  const deliveryRef = db.doc(`_pushDeliveries/${deliveryId}`);
  const shouldSchedule = await db.runTransaction(async (tx) => {
    const snap = await tx.get(deliveryRef);
    if (!snap.exists) return false;
    const d = snap.data() as AttendancePushDeliveryDoc;
    if (d.pushDelivered === true) return false;
    const scheduled = typeof d.retriesScheduled === "number" ? d.retriesScheduled : 0;
    if (scheduled >= PUSH_DELIVERY_MAX_RETRY_TASKS) return false;
    tx.update(deliveryRef, {
      retriesScheduled: PUSH_DELIVERY_MAX_RETRY_TASKS,
      retriesScheduledAt: FieldValue.serverTimestamp(),
    });
    return true;
  });

  if (!shouldSchedule) return;

  try {
    const queue = getFunctions().taskQueue(`locations/${REGION}/functions/${RETRY_TASK_FUNCTION}`);
    for (let i = 0; i < PUSH_DELIVERY_RETRY_DELAYS_SEC.length; i++) {
      const retryAttempt = i + 1;
      await queue.enqueue(
        { deliveryId, retryAttempt },
        {
          scheduleDelaySeconds: PUSH_DELIVERY_RETRY_DELAYS_SEC[i],
          id: `attn-push-${deliveryId}-r${retryAttempt}`,
          dispatchDeadlineSeconds: 300,
        },
      );
    }
    logger.info("scheduled attendance push retries", {
      deliveryId,
      parentUserId,
      delaysSec: [...PUSH_DELIVERY_RETRY_DELAYS_SEC],
    });
  } catch (e) {
    logger.error("maybeScheduleAttendancePushRetries enqueue failed", {
      deliveryId,
      parentUserId,
      e,
    });
  }
}

export async function createAttendancePushDeliveryDoc(
  db: admin.firestore.Firestore,
  params: {
    deliveryId: string;
    academyId: string;
    studentId: string;
    parentUserId: string;
    kind: "present" | "absent";
    studentName: string;
    body: string;
  },
): Promise<void> {
  const now = Date.now();
  await db.doc(`_pushDeliveries/${params.deliveryId}`).set({
    deliveryId: params.deliveryId,
    academyId: params.academyId,
    studentId: params.studentId,
    parentUserId: params.parentUserId,
    kind: params.kind,
    studentName: params.studentName,
    body: params.body,
    pushDelivered: false,
    fcmAttempts: 0,
    retriesScheduled: 0,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(now + PUSH_DELIVERY_DOC_TTL_MS),
  });
}

/** Cloud Tasks — 재전송 전용(추가 예약 없음) */
export const retryAttendancePushDelivery = onTaskDispatched(
  {
    region: REGION,
    retryConfig: { maxAttempts: 1 },
    rateLimits: { maxConcurrentDispatches: 5 },
  },
  async (req) => {
    const data = req.data as { deliveryId?: unknown; retryAttempt?: unknown };
    const deliveryId = typeof data.deliveryId === "string" ? data.deliveryId.trim() : "";
    const retryAttempt = data.retryAttempt;
    if (!deliveryId) return;
    if (retryAttempt !== 1 && retryAttempt !== 2) return;

    const db = admin.firestore();
    await deliverAttendancePushOnce(db, deliveryId, { allowScheduleRetries: false });
  },
);
