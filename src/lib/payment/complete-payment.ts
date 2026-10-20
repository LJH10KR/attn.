import type { PaymentClient } from "@portone/server-sdk";
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

export type PaymentType = "monthly_fixed" | "session_based";

export type CompletePaymentInput = {
  paymentId: string;
  studentId: string;
  academyId: string;
  paymentType: PaymentType;
  /** paymentType이 "session_based"일 때만 사용 */
  sessionCount?: number | null;
};

export type CompletePaymentResult =
  | { ok: true; alreadyProcessed: boolean }
  | { ok: false; error: string; status: number };

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * 결제 검증부터 Firestore 완결(결제 이력 저장 + session_based면 sessionBalance 자동 증가)까지
 * 담당하는 공용 로직. `/api/payment/verify`(클라이언트가 결제 직후 호출)와
 * `/api/portone-webhook`(클라이언트가 돌아오지 못한 경우의 서버 측 안전망)이 함께 사용한다.
 * 어느 쪽에서 먼저 호출되든 동일한 검증·트랜잭션을 거치므로 결과가 일관된다.
 */
export async function completePayment(
  portone: PaymentClient,
  input: CompletePaymentInput,
): Promise<CompletePaymentResult> {
  const { paymentId, studentId, academyId, paymentType } = input;

  const studentRef = adminDb.doc(`${academyStudentsPath(academyId)}/${studentId}`);
  const studentSnap = await studentRef.get();
  if (!studentSnap.exists) {
    return { ok: false, error: "학생 정보를 찾을 수 없습니다.", status: 404 };
  }

  const student = studentSnap.data() ?? {};
  const studentName = typeof student.name === "string" ? student.name : "";
  const parentUserId = typeof student.parentUserId === "string" ? student.parentUserId : "";

  // 결제 유형별로 "실제 결제해야 할 금액"을 서버 측 값만으로 계산 — 클라이언트/커스텀데이터가
  // 보낸 금액은 신뢰하지 않는다(금액 위변조 방지).
  let expectedAmount: number;
  let sessionCount: number | null = null;

  if (paymentType === "session_based") {
    const pricePerSession =
      typeof student.pricePerSession === "number" && student.pricePerSession > 0
        ? student.pricePerSession
        : null;
    if (pricePerSession == null) {
      return { ok: false, error: "회차당 금액 정보가 설정되어 있지 않습니다.", status: 400 };
    }
    if (!isPositiveInteger(input.sessionCount)) {
      return { ok: false, error: "sessionCount가 필요합니다.", status: 400 };
    }
    sessionCount = input.sessionCount;
    expectedAmount = pricePerSession * sessionCount;
  } else {
    const tuitionAmount =
      typeof student.tuitionAmount === "number" ? student.tuitionAmount : null;
    if (tuitionAmount == null) {
      return { ok: false, error: "원비 금액 정보가 설정되어 있지 않습니다.", status: 400 };
    }
    expectedAmount = tuitionAmount;
  }

  let payment;
  try {
    payment = await portone.getPayment({ paymentId });
  } catch (err) {
    console.error("[completePayment] 포트원 결제 조회 실패", err);
    return { ok: false, error: "결제 정보를 조회하지 못했습니다.", status: 502 };
  }

  if (payment.status !== "PAID") {
    return {
      ok: false,
      error: `결제가 완료되지 않았습니다. (status: ${String(payment.status)})`,
      status: 400,
    };
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
      console.error("[completePayment] 금액 불일치 결제 취소 실패", cancelErr);
    }
    return {
      ok: false,
      error:
        paymentType === "session_based"
          ? "결제 금액이 회차 금액과 일치하지 않습니다."
          : "결제 금액이 원비 금액과 일치하지 않습니다.",
      status: 400,
    };
  }

  const paymentRef = adminDb.doc(academyPaymentPath(academyId, paymentId));

  if (paymentType === "session_based") {
    const finalSessionCount = sessionCount!;

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
        console.error("[completePayment] adminInbox 알림 생성 실패", inboxErr);
      }
    }

    return { ok: true, alreadyProcessed };
  }

  // monthly_fixed — 이미 처리된 결제면 건너뛴다(웹훅 안전망과 verify가 동시에 들어와도 멱등).
  const existingSnap = await paymentRef.get();
  if (existingSnap.exists) {
    return { ok: true, alreadyProcessed: true };
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

  await paymentRef.set(paymentDoc, { merge: true });

  // 다음 달 원비 납부 알림이 다시 발송될 수 있도록 발송 이력 초기화
  await studentRef.update({ sentTuitionReminders: FieldValue.delete() });

  return { ok: true, alreadyProcessed: false };
}
