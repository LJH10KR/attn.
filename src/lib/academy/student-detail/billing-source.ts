import { collection, getDocs, limit, orderBy, query, where } from "firebase/firestore";
import {
  academyPaymentsPath,
  academyStudentSessionLogsPath,
  academyStudentTuitionInvoicesPath,
  type AcademyPaymentStatus,
} from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";

/**
 * 학생 상세 결제 탭의 데이터 출처 — 지금은 학생 하위 `tuitionInvoices`·`sessionLogs`와 학원 `payments`.
 * 4단계 청구서(`invoices`)·수납 장부로 바뀌면 이 파일만 바꾸고 시트는 화면용 타입만 쓴다.
 * 읽기 권한: 청구서 `billing.invoices`·`billing.collections`, 결제 `billing.payments`·`collections`·`refunds`,
 * 회차 기록 원장·활성 직원(규칙).
 */

export type StudentInvoiceRow = {
  /** YYYY-MM(납부일이 속한 달) */
  period: string;
  dueDate: string | null;
  status: "open" | "paid";
  /** 납부 완료면 확정 금액, 미납이면 null(원비 + 조정 합계로 계산) */
  finalAmount: number | null;
  adjustmentTotal: number;
  paidMethod: "card" | "manual" | null;
};

export async function loadStudentInvoices(
  academyId: string,
  studentId: string,
  max = 6,
): Promise<StudentInvoiceRow[]> {
  const snap = await getDocs(
    query(
      collection(getFirebaseDb(), academyStudentTuitionInvoicesPath(academyId, studentId)),
      orderBy("period", "desc"),
      limit(max),
    ),
  );
  return snap.docs.map((d) => {
    const x = d.data();
    const adjustments = Array.isArray(x.adjustments) ? (x.adjustments as { amount?: unknown }[]) : [];
    return {
      period: typeof x.period === "string" ? x.period : d.id,
      dueDate: typeof x.dueDate === "string" ? x.dueDate : null,
      status: x.status === "paid" ? "paid" : "open",
      finalAmount: x.status === "paid" && typeof x.finalAmount === "number" ? x.finalAmount : null,
      adjustmentTotal: adjustments.reduce((sum, a) => sum + (typeof a?.amount === "number" ? a.amount : 0), 0),
      paidMethod: x.paidMethod === "card" || x.paidMethod === "manual" ? x.paidMethod : null,
    };
  });
}

export type StudentPaymentRow = {
  id: string;
  amount: number;
  status: AcademyPaymentStatus;
  paymentType: "monthly_fixed" | "session_based";
  sessionCount: number | null;
  invoicePeriod: string | null;
  createdAtMs: number;
};

function millis(raw: unknown): number {
  return raw && typeof raw === "object" && "toMillis" in raw && typeof raw.toMillis === "function"
    ? (raw.toMillis as () => number)()
    : 0;
}

function readPaymentStatus(raw: unknown): AcademyPaymentStatus {
  return raw === "PAID" || raw === "FAILED" || raw === "CANCELLED" ? raw : "PENDING";
}

/** 학생 결제 — 학생당 건수가 적어 복합 인덱스 없이 받아 최근 순으로 정렬 */
export async function loadStudentPayments(
  academyId: string,
  studentId: string,
  max = 20,
): Promise<StudentPaymentRow[]> {
  const snap = await getDocs(
    query(collection(getFirebaseDb(), academyPaymentsPath(academyId)), where("studentId", "==", studentId)),
  );
  return snap.docs
    .map((d) => {
      const x = d.data();
      return {
        id: d.id,
        amount: typeof x.amount === "number" ? x.amount : 0,
        status: readPaymentStatus(x.status),
        paymentType: x.paymentType === "session_based" ? ("session_based" as const) : ("monthly_fixed" as const),
        sessionCount: typeof x.sessionCount === "number" ? x.sessionCount : null,
        invoicePeriod: typeof x.invoicePeriod === "string" ? x.invoicePeriod : null,
        createdAtMs: millis(x.createdAt),
      };
    })
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, max);
}

export type StudentSessionLogRow = {
  id: string;
  recordedAtMs: number;
  /** 잔여 0 이하에서 기록된 초과 수업 */
  wasExtra: boolean;
};

export async function loadStudentSessionLogs(
  academyId: string,
  studentId: string,
  max = 5,
): Promise<StudentSessionLogRow[]> {
  const snap = await getDocs(
    query(
      collection(getFirebaseDb(), academyStudentSessionLogsPath(academyId, studentId)),
      orderBy("recordedAt", "desc"),
      limit(max),
    ),
  );
  return snap.docs.map((d) => ({
    id: d.id,
    recordedAtMs: millis(d.get("recordedAt")),
    wasExtra: d.get("wasExtra") === true,
  }));
}
