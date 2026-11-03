import type { StudentInvoiceRow } from "@/lib/academy/student-detail/billing-source";

/**
 * 청구서 납부 상태 — 학생 상세 결제 탭 배지와 보호자 상세 "자녀 합산 미납"이 같이 쓴다(2-G 확정 2).
 * - paid: 납부 완료
 * - overdue(미납): 납부일(서울 기준)이 **지난** 미납부 청구서(`dueDate < 오늘`)
 * - upcoming(납부 예정): 납부일 당일·전의 미납부 청구서, 납부일이 없는 미납부 청구서
 */
export type InvoiceDueState = "paid" | "overdue" | "upcoming";

/** `todaySeoul` = 서울 기준 오늘 `YYYY-MM-DD`(`seoulDateString()`) */
export function invoiceDueState(
  row: Pick<StudentInvoiceRow, "status" | "dueDate">,
  todaySeoul: string,
): InvoiceDueState {
  if (row.status === "paid") return "paid";
  return row.dueDate && row.dueDate < todaySeoul ? "overdue" : "upcoming";
}

/** 청구서 금액 — 납부 완료면 확정 금액, 미납부면 원비 + 조정 합계(원비가 없으면 null = 금액 미정) */
export function invoiceAmount(
  row: Pick<StudentInvoiceRow, "finalAmount" | "adjustmentTotal">,
  tuitionAmount: number | null | undefined,
): number | null {
  return row.finalAmount ?? (tuitionAmount != null ? tuitionAmount + row.adjustmentTotal : null);
}

export const INVOICE_DUE_STATE_LABELS: Record<Exclude<InvoiceDueState, "paid">, string> = {
  overdue: "미납",
  upcoming: "납부 예정",
};

export const INVOICE_DUE_STATE_BADGE_CLASS: Record<InvoiceDueState, string> = {
  paid: "bg-emerald-500/15 text-emerald-900",
  overdue: "bg-red-500/15 text-red-900",
  upcoming: "bg-amber-500/20 text-amber-950",
};
