import { NextRequest, NextResponse } from "next/server";
import { PaymentClient } from "@portone/server-sdk";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import {
  ACADEMY_ADMIN_INBOX_SCHEMA_VERSION,
  academyAdminInboxCollectionPath,
  academyPaymentPath,
  academyStudentsPath,
  type AcademyAdminInboxDoc,
  type AcademyPaymentDoc,
} from "@/lib/firebase/attn-schema";

export const runtime = "nodejs";

type PaymentType = "monthly_fixed" | "session_based";

type VerifyRequestBody = {
  paymentId?: unknown;
  studentId?: unknown;
  academyId?: unknown;
  paymentType?: unknown;
  sessionCount?: unknown;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
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

  // 미지정 시(기존 원비 결제 UI) monthly_fixed로 취급 — 하위 호환
  const paymentType: PaymentType =
    body.paymentType === "session_based" ? "session_based" : "monthly_fixed";

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
  const studentName = typeof student.name === "string" ? student.name : "";
  const parentUserId =
    typeof student.parentUserId === "string" ? student.parentUserId : "";

  // 결제 유형별로 "실제 결제해야 할 금액"을 서버 측 값만으로 계산 — 클라이언트가 보낸
  // 금액은 신뢰하지 않는다(금액 위변조 방지).
  let expectedAmount: number;
  let sessionCount: number | null = null;

  if (paymentType === "session_based") {
    const pricePerSession =
      typeof student.pricePerSession === "number" && student.pricePerSession > 0
        ? student.pricePerSession
        : null;
    if (pricePerSession == null) {
      return NextResponse.json(
        { error: "회차당 금액 정보가 설정되어 있지 않습니다." },
        { status: 400 },
      );
    }
    if (!isPositiveInteger(body.sessionCount)) {
      return NextResponse.json(
        { error: "sessionCount가 필요합니다." },
        { status: 400 },
      );
    }
    sessionCount = body.sessionCount;
    expectedAmount = pricePerSession * sessionCount;
  } else {
    const tuitionAmount =
      typeof student.tuitionAmount === "number" ? student.tuitionAmount : null;
    if (tuitionAmount == null) {
      return NextResponse.json(
        { error: "원비 금액 정보가 설정되어 있지 않습니다." },
        { status: 400 },
      );
    }
    expectedAmount = tuitionAmount;
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

  if (payment.amount.total !== expectedAmount) {
    try {
      await portone.cancelPayment({
        paymentId,
        reason:
          paymentType === "session_based"
            ? "회차 결제 금액 불일치로 인한 자동 취소"
            : "원비 금액 불일치로 인한 자동 취소",
      });
    } catch (cancelErr) {
      console.error("[payment/verify] 금액 불일치 결제 취소 실패", cancelErr);
    }
    return NextResponse.json(
      {
        error:
          paymentType === "session_based"
            ? "결제 금액이 회차 금액과 일치하지 않습니다."
            : "결제 금액이 원비 금액과 일치하지 않습니다.",
      },
      { status: 400 },
    );
  }

  if (paymentType === "session_based") {
    const finalSessionCount = sessionCount!;
    const paymentRef = adminDb.doc(academyPaymentPath(academyId, paymentId));

    // 이중 충전 방지 — 결제 문서 존재 여부 확인, 잔여 조회, sessionBalance 증가를
    // 하나의 트랜잭션으로 원자 처리(동시 요청·재시도로 인한 중복 충전 차단).
    const alreadyProcessed = await adminDb.runTransaction(async (tx) => {
      const paymentSnap = await tx.get(paymentRef);
      if (paymentSnap.exists) {
        return true;
      }

      const studentSnapTx = await tx.get(studentRef);
      const studentDataTx = studentSnapTx.data() ?? {};
      const currentBalance =
        typeof studentDataTx.sessionBalance === "number" &&
        Number.isInteger(studentDataTx.sessionBalance)
          ? studentDataTx.sessionBalance
          : 0;
      const newBalance = currentBalance + finalSessionCount;

      const paymentDoc: AcademyPaymentDoc = {
        paymentId,
        studentId,
        studentName,
        parentUserId,
        amount: expectedAmount,
        status: "PAID",
        paymentType: "session_based",
        sessionCount: finalSessionCount,
        portoneTransactionId: payment.transactionId,
        createdAt: FieldValue.serverTimestamp() as unknown as AcademyPaymentDoc["createdAt"],
      };
      tx.set(paymentRef, paymentDoc);

      tx.update(studentRef, {
        sessionBalance: FieldValue.increment(finalSessionCount),
        // 충전 후에도 잔여가 0 미만이면(부채가 다 안 갚아졌으면) 초과 수업 기록을 유지
        ...(newBalance >= 0 ? { extraSessionDates: FieldValue.delete() } : {}),
        sentSessionPaymentReminder: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return false;
    });

    // adminInbox 알림은 트랜잭션 밖에서 처리 — 알림 실패가 충전 자체에 영향을 주지 않도록 분리.
    // 이미 처리된 결제(재시도 등)면 알림도 다시 보내지 않는다.
    if (!alreadyProcessed) {
      const inboxDoc: AcademyAdminInboxDoc = {
        schemaVersion: ACADEMY_ADMIN_INBOX_SCHEMA_VERSION,
        kind: "session_payment_received",
        entityType: "parent",
        entityId: parentUserId,
        displayName: studentName,
        email: "",
        studentName,
        sessionCount: finalSessionCount,
        createdAt: FieldValue.serverTimestamp() as unknown as AcademyAdminInboxDoc["createdAt"],
      };
      try {
        await adminDb
          .doc(`${academyAdminInboxCollectionPath(academyId)}/session-payment-${paymentId}`)
          .set(inboxDoc, { merge: true });
      } catch (inboxErr) {
        console.error("[payment/verify] adminInbox 알림 생성 실패", inboxErr);
      }
    }

    return NextResponse.json({ ok: true, status: "PAID" });
  }

  const paymentDoc: AcademyPaymentDoc = {
    paymentId,
    studentId,
    studentName,
    parentUserId,
    amount: expectedAmount,
    status: "PAID",
    paymentType: "monthly_fixed",
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
