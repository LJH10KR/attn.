import { NextRequest, NextResponse } from "next/server";
import { Webhook } from "@portone/server-sdk";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import type { AcademyPaymentStatus } from "@/lib/firebase/attn-schema";

export const runtime = "nodejs";

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
    // /api/payment/verify가 아직 문서를 만들지 않았거나(레이스), 검증되지 않은 결제 —
    // 갱신할 대상이 없으므로 에러 없이 무시(포트원 재시도 폭주 방지)
    console.warn(`[portone-webhook] 매칭되는 결제 문서를 찾지 못했습니다: paymentId=${paymentId}`);
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

  await matches.docs[0].ref.update(update);

  return NextResponse.json({ ok: true });
}
