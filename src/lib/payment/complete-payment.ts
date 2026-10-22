import type { PaymentClient } from "@portone/server-sdk";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import {
  ACADEMY_ADMIN_INBOX_SCHEMA_VERSION,
  academyAdminInboxCollectionPath,
  academyPaymentPath,
  academyStudentsPath,
  academyStudentTuitionInvoicesPath,
  type AcademyAdminInboxDoc,
  type AcademyPaymentDoc,
} from "@/lib/firebase/attn-schema";
import {
  computeInvoiceFinalAmount,
  invoiceDueDate,
  isValidInvoicePeriod,
  nextDueInvoicePeriod,
  sanitizeInvoiceAdjustments,
  shiftInvoicePeriod,
} from "@/lib/payment/tuition-invoice";

export type PaymentType = "monthly_fixed" | "session_based";

export type CompletePaymentInput = {
  paymentId: string;
  studentId: string;
  academyId: string;
  paymentType: PaymentType;
  /** paymentType이 "session_based"일 때만 사용 */
  sessionCount?: number | null;
  /**
   * paymentType이 "monthly_fixed"일 때 학부모 화면이 보여준 청구서(YYYY-MM).
   * 미지정(청구서 도입 이전 클라이언트·웹훅)이거나 허용 범위 밖이면 서버가 다음 납부일 기준으로 정함.
   */
  invoicePeriod?: string | null;
};

export type CompletePaymentResult =
  | { ok: true; alreadyProcessed: boolean }
  | { ok: false; error: string; status: number };

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * 결제할 청구서 결정 — 클라이언트가 보낸 달이 다음 납부 달이거나 그 직전 달(납부일 자정 직후 결제 등)이면
 * 그대로, 아니면 다음 납부 달.
 */
function resolveInvoicePeriod(requested: unknown, dueDayOfMonth: number): string {
  const next = nextDueInvoicePeriod(dueDayOfMonth);
  if (
    isValidInvoicePeriod(requested) &&
    (requested === next || requested === shiftInvoicePeriod(next, -1))
  ) {
    return requested;
  }
  return next;
}

async function cancelPortonePayment(
  portone: PaymentClient,
  paymentId: string,
  reason: string,
): Promise<void> {
  try {
    await portone.cancelPayment({ paymentId, reason });
  } catch (cancelErr) {
    console.error(`[completePayment] 자동 취소 실패 (${reason})`, cancelErr);
  }
}

/**
 * 결제 검증부터 Firestore 완결(결제 이력 저장 + session_based면 sessionBalance 자동 증가,
 * monthly_fixed면 청구서 납부 처리)까지 담당하는 공용 로직. `/api/payment/verify`(클라이언트가 결제 직후 호출)와
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
  // 보낸 금액은 신뢰하지 않는다(금액 위변조 방지). 월 원비는 청구서 조정 항목이 반영되므로
  // 납부 처리 트랜잭션 안에서 계산한다(completeMonthlyPayment).
  let expectedAmount = 0;
  let sessionCount: number | null = null;
  let invoicePeriod: string | null = null;
  let dueDayOfMonth = 0;

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
    if (typeof student.tuitionAmount !== "number") {
      return { ok: false, error: "원비 금액 정보가 설정되어 있지 않습니다.", status: 400 };
    }
    const dueDay = student.tuitionDueDayOfMonth;
    if (typeof dueDay !== "number" || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
      return { ok: false, error: "원비 납부일 정보가 설정되어 있지 않습니다.", status: 400 };
    }
    dueDayOfMonth = dueDay;
    invoicePeriod = resolveInvoicePeriod(input.invoicePeriod, dueDay);
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

  if (paymentType === "monthly_fixed") {
    return completeMonthlyPayment(portone, {
      paymentId,
      studentId,
      academyId,
      studentName,
      parentUserId,
      invoicePeriod: invoicePeriod!,
      dueDayOfMonth,
      paidAmount: payment.amount.total,
      transactionId: payment.transactionId,
    });
  }

  if (payment.amount.total !== expectedAmount) {
    await cancelPortonePayment(portone, paymentId, "회차 결제 금액 불일치로 인한 자동 취소");
    return {
      ok: false,
      error: "결제 금액이 회차 금액과 일치하지 않습니다.",
      status: 400,
    };
  }

  const paymentRef = adminDb.doc(academyPaymentPath(academyId, paymentId));
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

/**
 * 월 원비 카드 결제 완결 — 결제 문서 생성과 청구서 납부 처리를 하나의 트랜잭션으로 처리.
 * 청구 금액(원비 + 조정 합계)을 트랜잭션 안에서 계산하므로, 결제 직전 학원이 조정 항목을 바꿔도
 * 실제 결제 금액과 다르면 납부로 인정하지 않는다. 이미 납부된 청구서에 대한 결제(이중 결제)와
 * 금액 불일치 결제는 포트원에서 자동 취소한다.
 */
async function completeMonthlyPayment(
  portone: PaymentClient,
  params: {
    paymentId: string;
    studentId: string;
    academyId: string;
    studentName: string;
    parentUserId: string;
    invoicePeriod: string;
    dueDayOfMonth: number;
    paidAmount: number;
    transactionId: string;
  },
): Promise<CompletePaymentResult> {
  const { paymentId, studentId, academyId, studentName, parentUserId, invoicePeriod } = params;
  const paymentRef = adminDb.doc(academyPaymentPath(academyId, paymentId));
  const studentRef = adminDb.doc(`${academyStudentsPath(academyId)}/${studentId}`);
  const invoiceRef = adminDb.doc(
    `${academyStudentTuitionInvoicesPath(academyId, studentId)}/${invoicePeriod}`,
  );

  const outcome = await adminDb.runTransaction(async (tx) => {
    const [paymentSnap, studentSnap, invoiceSnap] = await tx.getAll(
      paymentRef,
      studentRef,
      invoiceRef,
    );
    // 웹훅 안전망과 verify가 동시에 들어와도 멱등
    if (paymentSnap!.exists) return "already" as const;

    const invoice = invoiceSnap!.data() ?? {};
    if (invoice.status === "paid") return "duplicate" as const;

    const baseAmount = studentSnap!.get("tuitionAmount");
    if (typeof baseAmount !== "number") return "mismatch" as const;
    const finalAmount = computeInvoiceFinalAmount(
      baseAmount,
      sanitizeInvoiceAdjustments(invoice.adjustments),
    );
    if (params.paidAmount !== finalAmount) return "mismatch" as const;

    const paymentDoc: AcademyPaymentDoc = {
      paymentId,
      studentId,
      studentName,
      parentUserId,
      amount: finalAmount,
      status: "PAID",
      paymentType: "monthly_fixed",
      invoicePeriod,
      portoneTransactionId: params.transactionId,
      createdAt: FieldValue.serverTimestamp() as unknown as AcademyPaymentDoc["createdAt"],
    };
    tx.set(paymentRef, paymentDoc);

    tx.set(invoiceRef, {
      period: invoicePeriod,
      dueDate: invoiceDueDate(invoicePeriod, params.dueDayOfMonth),
      status: "paid",
      adjustments: Array.isArray(invoice.adjustments) ? invoice.adjustments : [],
      baseAmount,
      finalAmount,
      paidAt: FieldValue.serverTimestamp(),
      paidMethod: "card",
      paymentId,
      createdAt: invoice.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // 다음 달 원비 납부 알림이 다시 발송될 수 있도록 발송 이력 초기화
    tx.update(studentRef, { sentTuitionReminders: FieldValue.delete() });
    return "ok" as const;
  });

  switch (outcome) {
    case "already":
      return { ok: true, alreadyProcessed: true };
    case "ok":
      return { ok: true, alreadyProcessed: false };
    case "duplicate":
      await cancelPortonePayment(portone, paymentId, "이미 납부된 원비 중복 결제 자동 취소");
      return {
        ok: false,
        error: "이미 납부가 완료된 원비입니다. 이번 결제는 자동으로 취소됩니다.",
        status: 409,
      };
    case "mismatch":
      await cancelPortonePayment(portone, paymentId, "원비 금액 불일치로 인한 자동 취소");
      return {
        ok: false,
        error: "결제 금액이 청구 금액과 일치하지 않습니다. 새로고침 후 다시 시도해 주세요.",
        status: 400,
      };
  }
}

/**
 * 카드 결제가 전액 취소되면 그 결제로 납부 처리된 청구서를 미납 상태로 되돌린다
 * (`/api/payment/cancel`, 포트원 웹훅 Transaction.Cancelled에서 호출).
 */
export async function reopenInvoiceForCancelledPayment(
  academyId: string,
  payment: { paymentId?: unknown; studentId?: unknown; invoicePeriod?: unknown },
): Promise<void> {
  const { paymentId, studentId, invoicePeriod } = payment;
  if (
    typeof paymentId !== "string" ||
    typeof studentId !== "string" ||
    !isValidInvoicePeriod(invoicePeriod)
  ) {
    return;
  }
  const invoiceRef = adminDb.doc(
    `${academyStudentTuitionInvoicesPath(academyId, studentId)}/${invoicePeriod}`,
  );
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(invoiceRef);
    if (!snap.exists || snap.get("status") !== "paid" || snap.get("paymentId") !== paymentId) {
      return;
    }
    tx.update(invoiceRef, {
      status: "open",
      baseAmount: FieldValue.delete(),
      finalAmount: FieldValue.delete(),
      paidAt: FieldValue.delete(),
      paidMethod: FieldValue.delete(),
      paymentId: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}
