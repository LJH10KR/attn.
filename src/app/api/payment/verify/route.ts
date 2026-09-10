import { NextRequest, NextResponse } from "next/server";
import { PaymentClient } from "@portone/server-sdk";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import {
  academyPaymentPath,
  academyStudentsPath,
  type AcademyPaymentDoc,
} from "@/lib/firebase/attn-schema";

export const runtime = "nodejs";

type VerifyRequestBody = {
  paymentId?: unknown;
  studentId?: unknown;
  academyId?: unknown;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function POST(request: NextRequest) {
  let body: VerifyRequestBody;
  try {
    body = (await request.json()) as VerifyRequestBody;
  } catch {
    return NextResponse.json({ error: "잘못된 요청 형식입니다." }, { status: 400 });
  }

  const { paymentId, studentId, academyId } = body;
  if (
    !isNonEmptyString(paymentId) ||
    !isNonEmptyString(studentId) ||
    !isNonEmptyString(academyId)
  ) {
    return NextResponse.json(
      { error: "paymentId, studentId, academyId가 필요합니다." },
      { status: 400 },
    );
  }

  const apiSecret = process.env.PORTONE_API_SECRET;
  if (!apiSecret) {
    console.error("[payment/verify] PORTONE_API_SECRET 환경변수가 설정되지 않았습니다.");
    return NextResponse.json({ error: "결제 서버 설정 오류입니다." }, { status: 500 });
  }

  const studentRef = adminDb.doc(`${academyStudentsPath(academyId)}/${studentId}`);
  const studentSnap = await studentRef.get();
  if (!studentSnap.exists) {
    return NextResponse.json({ error: "학생 정보를 찾을 수 없습니다." }, { status: 404 });
  }

  const student = studentSnap.data() ?? {};
  const tuitionAmount =
    typeof student.tuitionAmount === "number" ? student.tuitionAmount : null;
  const studentName = typeof student.name === "string" ? student.name : "";
  const parentUserId =
    typeof student.parentUserId === "string" ? student.parentUserId : "";

  if (tuitionAmount == null) {
    return NextResponse.json(
      { error: "원비 금액 정보가 설정되어 있지 않습니다." },
      { status: 400 },
    );
  }

  const portone = PaymentClient({ secret: apiSecret });

  let payment;
  try {
    payment = await portone.getPayment({ paymentId });
  } catch (err) {
    console.error("[payment/verify] 포트원 결제 조회 실패", err);
    return NextResponse.json({ error: "결제 정보를 조회하지 못했습니다." }, { status: 502 });
  }

  if (payment.status !== "PAID") {
    return NextResponse.json(
      { error: `결제가 완료되지 않았습니다. (status: ${String(payment.status)})` },
      { status: 400 },
    );
  }

  // 실제 결제 금액 vs Firestore tuitionAmount 비교 — 클라이언트가 보낸 금액이 아니라
  // 학생 문서의 서버 측 값과 포트원 조회 결과만 신뢰(금액 위변조 방지)
  if (payment.amount.total !== tuitionAmount) {
    try {
      await portone.cancelPayment({
        paymentId,
        reason: "원비 금액 불일치로 인한 자동 취소",
      });
    } catch (cancelErr) {
      console.error("[payment/verify] 금액 불일치 결제 취소 실패", cancelErr);
    }
    return NextResponse.json(
      { error: "결제 금액이 원비 금액과 일치하지 않습니다." },
      { status: 400 },
    );
  }

  const paymentDoc: AcademyPaymentDoc = {
    paymentId,
    studentId,
    studentName,
    parentUserId,
    amount: tuitionAmount,
    status: "PAID",
    portoneTransactionId: payment.transactionId,
    createdAt: FieldValue.serverTimestamp() as unknown as AcademyPaymentDoc["createdAt"],
  };

  await adminDb
    .doc(academyPaymentPath(academyId, paymentId))
    .set(paymentDoc, { merge: true });

  // 다음 달 원비 납부 알림이 다시 발송될 수 있도록 발송 이력 초기화
  await studentRef.update({ sentTuitionReminders: FieldValue.delete() });

  return NextResponse.json({ ok: true, status: "PAID" });
}
