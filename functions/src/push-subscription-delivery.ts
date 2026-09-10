import * as admin from "firebase-admin";
import { FieldValue, Timestamp, type DocumentReference } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

/** FCM이 토큰을 더 이상 쓸 수 없다고 판단할 때 */
export const FCM_TOKEN_INVALID_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

/** 일시 오류 — 구독 문서를 삭제하지 않음 */
export const FCM_NEVER_DELETE_SUBSCRIPTION_CODES = new Set([
  "messaging/unavailable",
  "messaging/internal-error",
  "messaging/internal",
  "messaging/server-unavailable",
  "messaging/timeout",
  "messaging/quota-exceeded",
  "messaging/message-rate-exceeded",
  "messaging/device-message-rate-exceeded",
  "messaging/too-many-topics",
  "messaging/payload-size-limit-exceeded",
  "messaging/invalid-payload",
  "messaging/invalid-package-name",
  "messaging/mismatched-credential",
  "messaging/sender-id-mismatch",
  "messaging/third-party-auth-error",
]);

/** sync 직후 첫 전송이 무효로 나오는 iOS PWA 경계 구간 — 이 시간 동안은 삭제하지 않음 */
export const PUSH_INVALID_DELETE_GRACE_MS = 3 * 60 * 1000;

/** grace 이후 연속(누적) 무효 전송 이 횟수에 도달할 때만 구독 삭제 */
export const PUSH_INVALID_FAILURES_BEFORE_DELETE = 2;

/** 롤오버·다기기 여유 — 사용자당 최대 구독 문서 수 */
export const PUSH_MAX_SUBSCRIPTIONS_PER_USER = 3;

/** 이 기간보다 오래된(현재 토큰 제외) 구독은 sync 시 정리 */
export const PUSH_SUBSCRIPTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type PushTokenBucket = {
  token: string;
  refs: DocumentReference[];
  /** 구독 문서 `updatedAt` 중 가장 최근(ms) */
  updatedAtMillis: number;
  /** 문서별 `invalidDeliveryCount` (없으면 0) */
  invalidCounts: number[];
};

/** 로그용 — 전체 토큰을 남기지 않음 */
export function fcmTokenPrefix(token: string): string {
  if (token.length <= 12) return "[short]";
  return `${token.slice(0, 8)}…`;
}

function graceDeadlineMs(userLastSyncedAt: Timestamp | undefined, bucket: PushTokenBucket): number {
  const userMs = userLastSyncedAt?.toMillis() ?? 0;
  return Math.max(userMs, bucket.updatedAtMillis) + PUSH_INVALID_DELETE_GRACE_MS;
}

/**
 * multicast 결과에 따라 구독을 갱신합니다. 무효 토큰은 grace·2회 누적 실패 후에만 삭제합니다.
 */
export async function applyMulticastDeliveryResults(params: {
  db: admin.firestore.Firestore;
  parentUserId: string;
  userLastSyncedAt?: Timestamp;
  buckets: PushTokenBucket[];
  responses: admin.messaging.SendResponse[];
  logContext: string;
}): Promise<{ removedCount: number; skippedGraceCount: number }> {
  const { db, parentUserId, userLastSyncedAt, buckets, responses, logContext } = params;
  const now = Date.now();
  const toDelete: DocumentReference[] = [];
  const toUpdate: { ref: DocumentReference; data: Record<string, unknown> }[] = [];
  let skippedGraceCount = 0;

  for (let i = 0; i < responses.length; i++) {
    const r = responses[i];
    const bucket = buckets[i];
    if (!bucket) continue;

    if (r.success) {
      for (let j = 0; j < bucket.refs.length; j++) {
        toUpdate.push({
          ref: bucket.refs[j]!,
          data: {
            invalidDeliveryCount: 0,
            lastDeliveredAt: FieldValue.serverTimestamp(),
          },
        });
      }
      continue;
    }

    const code = r.error?.code ?? "";
    if (FCM_NEVER_DELETE_SUBSCRIPTION_CODES.has(code) || !FCM_TOKEN_INVALID_CODES.has(code)) {
      if (code) {
        logger.warn(`${logContext} push delivery non-fatal error`, {
          parentUserId,
          errorCode: code,
          tokenPrefix: fcmTokenPrefix(bucket.token),
        });
      }
      continue;
    }

    if (now < graceDeadlineMs(userLastSyncedAt, bucket)) {
      skippedGraceCount += bucket.refs.length;
      logger.warn(`${logContext} skipped invalid-token cleanup (grace period)`, {
        parentUserId,
        errorCode: code,
        tokenPrefix: fcmTokenPrefix(bucket.token),
      });
      continue;
    }

    for (let j = 0; j < bucket.refs.length; j++) {
      const ref = bucket.refs[j]!;
      const prev = bucket.invalidCounts[j] ?? 0;
      const next = prev + 1;
      if (next >= PUSH_INVALID_FAILURES_BEFORE_DELETE) {
        toDelete.push(ref);
        logger.warn(`${logContext} removing stale push subscription`, {
          parentUserId,
          errorCode: code,
          tokenPrefix: fcmTokenPrefix(bucket.token),
          invalidDeliveryCount: next,
        });
      } else {
        toUpdate.push({
          ref,
          data: {
            invalidDeliveryCount: next,
            lastInvalidAt: FieldValue.serverTimestamp(),
            lastInvalidCode: code,
          },
        });
        logger.warn(`${logContext} invalid token delivery (subscription kept)`, {
          parentUserId,
          errorCode: code,
          tokenPrefix: fcmTokenPrefix(bucket.token),
          invalidDeliveryCount: next,
        });
      }
    }
  }

  if (toUpdate.length > 0 || toDelete.length > 0) {
    let batch = db.batch();
    let n = 0;
    const commitIfNeeded = async () => {
      if (n > 0) {
        await batch.commit();
        batch = db.batch();
        n = 0;
      }
    };
    for (const { ref, data } of toUpdate) {
      batch.set(ref, data, { merge: true });
      n++;
      if (n >= 450) await commitIfNeeded();
    }
    for (const ref of toDelete) {
      batch.delete(ref);
      n++;
      if (n >= 450) await commitIfNeeded();
    }
    await commitIfNeeded();
  }

  if (toDelete.length > 0) {
    logger.warn(`${logContext} removed stale push subscriptions`, {
      parentUserId,
      removedCount: toDelete.length,
      skippedGraceCount,
    });
  }

  return { removedCount: toDelete.length, skippedGraceCount };
}

/**
 * sync 시 현재 토큰은 유지하고, 오래되었거나 개수 초과인 구독만 정리합니다.
 */
export async function pruneStalePushSubscriptions(
  userRef: FirebaseFirestore.DocumentReference,
  keepSubId: string,
): Promise<number> {
  const subs = await userRef.collection("pushSubscriptions").get();
  const now = Date.now();
  const candidates: { ref: DocumentReference; updatedAtMillis: number; id: string }[] = [];

  for (const d of subs.docs) {
    if (d.id === keepSubId) continue;
    const ts = d.get("updatedAt") as Timestamp | undefined;
    candidates.push({
      ref: d.ref,
      id: d.id,
      updatedAtMillis: ts?.toMillis() ?? 0,
    });
  }

  const toDelete = new Set<DocumentReference>();

  for (const c of candidates) {
    if (now - c.updatedAtMillis > PUSH_SUBSCRIPTION_MAX_AGE_MS) {
      toDelete.add(c.ref);
    }
  }

  const remaining = candidates.filter((c) => !toDelete.has(c.ref));
  remaining.sort((a, b) => a.updatedAtMillis - b.updatedAtMillis);

  const maxOthers = PUSH_MAX_SUBSCRIPTIONS_PER_USER - 1;
  if (remaining.length > maxOthers) {
    const excess = remaining.length - maxOthers;
    for (let i = 0; i < excess; i++) {
      toDelete.add(remaining[i]!.ref);
    }
  }

  if (toDelete.size === 0) return 0;

  let batch = userRef.firestore.batch();
  let n = 0;
  for (const ref of toDelete) {
    batch.delete(ref);
    n++;
    if (n >= 450) {
      await batch.commit();
      batch = userRef.firestore.batch();
      n = 0;
    }
  }
  if (n > 0) await batch.commit();
  return toDelete.size;
}
