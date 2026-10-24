import { NextRequest, NextResponse } from "next/server";
import { PaymentClient, Webhook } from "@portone/server-sdk";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import {
  completePayment,
  reopenInvoiceForCancelledPayment,
  type PaymentType,
} from "@/lib/payment/complete-payment";
import type { AcademyPaymentStatus } from "@/lib/firebase/attn-schema";

export const runtime = "nodejs";

type PaymentCustomData = {
  studentId?: unknown;
  academyId?: unknown;
  paymentType?: unknown;
  sessionCount?: unknown;
  invoicePeriod?: unknown;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 클라이언트가 /payment/complete로 돌아오지 못해(브라우저를 닫음 등) /api/payment/verify가
 * 한 번도 호출되지 않은 경우의 안전망. 결제 요청 시 심어둔 customData(studentId, academyId,
 * paymentType, sessionCount)를 결제 단건 조회로 복원해 completePayment()를 대신 실행한다.
 */
async function completeFromWebhookFallback(
  portone: ReturnType<typeof PaymentClient>,
  paymentId: string,
): Promise<void> {
  let payment;
  try {
    payment = await portone.getPayment({ paymentId });
  } catch (err) {
    console.error("[portone-webhook] 안전망 처리용 결제 조회 실패", err);
    return;
  }

  // 알 수 없는(향후 SDK 버전의) 결제 상태는 customData 필드 자체가 타입에 없음
  const customDataRaw = "customData" in payment ? payment.customData : undefined;
  if (!customDataRaw) {
    console.warn(`[portone-webhook] customData 없음 — 안전망 처리 불가: paymentId=${paymentId}`);
    return;
  }

  let customData: PaymentCustomData;
  try {
    customData = JSON.parse(customDataRaw) as PaymentCustomData;
  } catch (err) {
    console.error("[portone-webhook] customData 파싱 실패", err);
    return;
  }

  const { studentId, academyId } = customData;
  if (!isNonEmptyString(studentId) || !isNonEmptyString(academyId)) {
    console.warn(`[portone-webhook] customData에 studentId/academyId 없음: paymentId=${paymentId}`);
    return;
  }

  const paymentType: PaymentType =
    customData.paymentType === "session_based" ? "session_based" : "monthly_fixed";
  const sessionCount =
    typeof customData.sessionCount === "number" ? customData.sessionCount : null;

  const result = await completePayment(portone, {
    paymentId,
    studentId,
    academyId,
    paymentType,
    sessionCount,
    invoicePeriod: typeof customData.invoicePeriod === "string" ? customData.invoicePeriod : null,
  });

  if (!result.ok) {
    console.error(
      `[portone-webhook] 안전망 처리 실패: paymentId=${paymentId}, error=${result.error}`,
    );
    return;
  }

  if (result.alreadyProcessed) {
    console.info(
      `[portone-webhook] 이미 처리된 결제(verify가 먼저 완료함) — 안전망 개입 불필요: paymentId=${paymentId}`,
    );
  } else {
    console.info(
      `[portone-webhook] verify 없이 안전망이 처음부터 독립적으로 결제를 완결함: paymentId=${paymentId}`,
    );
  }
}

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.PORTONE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error(
      "[portone-webhook] PORTONE_WEBHOOK_SECRET 환경변수가 설정되지 않았습니다.",
    );
    return NextResponse.json({ error: "웹훅 서버 설정 오류입니다." }, { status: 500 });
  }

  // 시그니처 검증을 위해 body는 반드시 원문 text로 읽어야 함(JSON 파싱 전 raw payload 필요)
  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let event;
  try {
    event = await Webhook.verify(webhookSecret, rawBody, headers);
  } catch (err) {
    console.error("[portone-webhook] 웹훅 검증 실패", err);
    return NextResponse.json({ error: "웹훅 검증에 실패했습니다." }, { status: 400 });
  }

  let status: AcademyPaymentStatus;
  let paymentId: string;
  let transactionId: string;
  // 부분 취소는 납부 상태를 유지 — 전액 취소일 때만 청구서를 미납으로 되돌림
  const fullyCancelled = event.type === "Transaction.Cancelled";

  switch (event.type) {
    case "Transaction.Paid":
      status = "PAID";
      paymentId = event.data.paymentId;
      transactionId = event.data.transactionId;
      break;
    case "Transaction.Cancelled":
    case "Transaction.PartialCancelled":
      status = "CANCELLED";
      paymentId = event.data.paymentId;
      transactionId = event.data.transactionId;
      break;
    case "Transaction.Failed":
      status = "FAILED";
      paymentId = event.data.paymentId;
      transactionId = event.data.transactionId;
      break;
    default:
      // 관심 없는(알 수 없는) 이벤트 타입 — 조용히 무시하고 200 반환
      return NextResponse.json({ ok: true });
  }

  // paymentId는 클라이언트가 생성해 학원별 서브컬렉션 문서 ID로도 쓰이지만,
  // 웹훅에는 academyId가 없으므로 문서에 중복 저장해둔 paymentId 필드로 collectionGroup 조회
  const matches = await adminDb
    .collectionGroup("payments")
    .where("paymentId", "==", paymentId)
    .limit(1)
    .get();

  if (matches.empty) {
    if (status === "PAID") {
      // /api/payment/verify가 아직 문서를 만들지 못한 경우(레이스 또는 사용자가 결제 후
      // /payment/complete로 돌아오지 못함) — customData로 서버가 독립적으로 완결 시도.
      const apiSecret = process.env.PORTONE_API_SECRET;
      if (!apiSecret) {
        console.error("[portone-webhook] PORTONE_API_SECRET 환경변수가 설정되지 않았습니다.");
        return NextResponse.json({ ok: true });
      }
      await completeFromWebhookFallback(PaymentClient({ secret: apiSecret }), paymentId);
    } else {
      // 결제 이력이 없는 취소/실패는 되돌릴 것도 없으므로 무시(포트원 재시도 폭주 방지)
      console.warn(
        `[portone-webhook] 매칭되는 결제 문서를 찾지 못했습니다: paymentId=${paymentId}`,
      );
    }
    return NextResponse.json({ ok: true });
  }

  const update: Record<string, unknown> = {
    status,
    portoneTransactionId: transactionId,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (status === "CANCELLED") {
    update.cancelledAt = FieldValue.serverTimestamp();
  }

  const paymentDoc = matches.docs[0];
  await paymentDoc.ref.update(update);

  if (fullyCancelled) {
    // 경로: academies/{academyId}/payments/{paymentId}
    const academyId = paymentDoc.ref.parent.parent?.id;
    if (academyId) {
      await reopenInvoiceForCancelledPayment(academyId, paymentDoc.data());
    }
  }

  return NextResponse.json({ ok: true });
}
