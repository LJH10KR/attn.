import * as admin from "firebase-admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import { applyMulticastDeliveryResults, buildTokenBuckets } from "./push-subscription-delivery";

const REGION = "asia-northeast3";

/**
 * 학부모가 결제 완료 화면(/payment/complete)으로 돌아오지 못해도(모바일 PWA에서 은행 앱 →
 * 브라우저로 튕겨 복귀 못 하는 경우 등) /api/payment/verify 또는 웹훅 안전망 중 어느 쪽이
 * 결제를 완결하든, 결제 문서가 처음 생성되는 이 순간에만 한 번 발송된다(생성 시에만 실행되는
 * onDocumentCreated이므로 재시도로 인한 중복 발송 걱정이 없음).
 */
export const sendPaymentCompletedPush = onDocumentCreated(
  {
    document: "academies/{academyId}/payments/{paymentId}",
    region: REGION,
    memory: "256MiB",
  },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    if (data.status !== "PAID") return;

    const parentUserId = typeof data.parentUserId === "string" ? data.parentUserId : "";
    if (!parentUserId) return;

    const studentName =
      typeof data.studentName === "string" && data.studentName ? data.studentName : "학생";
    const paymentType = data.paymentType === "session_based" ? "session_based" : "monthly_fixed";
    const sessionCount =
      typeof data.sessionCount === "number" && data.sessionCount > 0 ? data.sessionCount : null;
    const amount = typeof data.amount === "number" ? data.amount : null;

    const db = admin.firestore();
    const parentUserRef = db.doc(`users/${parentUserId}`);
    const userSnap = await parentUserRef.get();
    if (!userSnap.exists || userSnap.get("pushNotificationsEnabled") !== true) {
      logger.info("sendPaymentCompletedPush: parent push disabled, skipping", { parentUserId });
      return;
    }

    const subsSnap = await parentUserRef.collection("pushSubscriptions").get();
    const buckets = buildTokenBuckets(subsSnap);
    const tokens = buckets.map((b) => b.token);
    if (tokens.length === 0) {
      logger.info("sendPaymentCompletedPush: no FCM tokens, skipping", { parentUserId });
      return;
    }

    const userData = userSnap.data();
    const userLastSyncedAt =
      (userData?.pushLastSyncServerAt as admin.firestore.Timestamp | undefined) ??
      (userData?.pushSubscriptionLastSyncedAt as admin.firestore.Timestamp | undefined);

    const body =
      paymentType === "session_based"
        ? `${studentName} 학생의 회차 결제(${sessionCount ?? "?"}회)가 완료됐습니다.`
        : `${studentName} 학생의 원비 결제가 완료됐습니다.`;

    const dataPayload: Record<string, string> = {
      title: "attn.",
      body,
      type: "payment_completed",
      url: "/parent",
      academyId: event.params.academyId,
      studentId: typeof data.studentId === "string" ? data.studentId : "",
      parentUserId,
    };
    if (amount != null) dataPayload.amount = String(amount);

    const resp = await admin.messaging().sendEachForMulticast({ tokens, data: dataPayload });

    if (resp.failureCount > 0) {
      logger.warn("sendPaymentCompletedPush: FCM partial failure", {
        parentUserId,
        successCount: resp.successCount,
        failureCount: resp.failureCount,
      });
    }

    await applyMulticastDeliveryResults({
      db,
      parentUserId,
      userLastSyncedAt,
      buckets,
      responses: resp.responses,
      logContext: "sendPaymentCompletedPush",
    });
  },
);
