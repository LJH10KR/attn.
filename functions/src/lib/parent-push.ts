import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import type { Timestamp } from "firebase-admin/firestore";
import { applyMulticastDeliveryResults, buildTokenBuckets } from "../push-subscription-delivery";

/**
 * 학부모 앱 푸시 1회(2-L L-3) — 구독 토큰으로 멀티캐스트 한 번, 재시도 작업 없음.
 * 알림을 끈 계정·토큰이 없는 계정은 보내지 않는다. 실패해도 던지지 않는다(호출한 저장은 이미 끝남).
 * 본문에 전화번호를 넣지 않는다.
 */
export async function sendParentAppPush(
  db: admin.firestore.Firestore,
  recipientUid: string,
  data: { body: string; type: string; url: string; academyId: string } & Record<string, string>,
): Promise<boolean> {
  try {
    const userRef = db.doc(`users/${recipientUid}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists || userSnap.get("pushNotificationsEnabled") !== true) return false;
    const buckets = buildTokenBuckets(await userRef.collection("pushSubscriptions").get());
    if (buckets.length === 0) return false;
    const resp = await admin.messaging().sendEachForMulticast({
      tokens: buckets.map((b) => b.token),
      data: { title: "attn.", recipientUid, ...data },
    });
    const userLastSyncedAt =
      (userSnap.get("pushLastSyncServerAt") as Timestamp | undefined) ??
      (userSnap.get("pushSubscriptionLastSyncedAt") as Timestamp | undefined);
    await applyMulticastDeliveryResults({
      db,
      recipientUid,
      userLastSyncedAt,
      buckets,
      responses: resp.responses,
      logContext: `sendParentAppPush(${data.type})`,
    });
    return resp.successCount > 0;
  } catch (e) {
    logger.warn("sendParentAppPush 실패(무시)", { recipientUid, type: data.type, e });
    return false;
  }
}
