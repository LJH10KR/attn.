"use client";

import { collection, getDocs, orderBy, query, Timestamp, where } from "firebase/firestore";
import { academyPaymentsPath, type AcademyPaymentDoc, type AcademyPaymentStatus } from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";
import { downloadCsv, type CsvColumn } from "@/lib/ui/csv";

/**
 * 결제 내역 CSV(2-N N8) — 학원 삭제 확인 창(전체 기간)과 결제 내역 화면(보고 있는 달)이 같은 열을 쓴다.
 * 결제 판매자는 학원이라 법령 보관 의무도 학원 — 학원 삭제 전에 내려받아 보관하도록 안내. 학부모 계정 ID는 넣지 않는다.
 */

export type PaymentCsvRow = AcademyPaymentDoc & { id: string };

const STATUS_LABEL: Record<AcademyPaymentStatus, string> = {
  PAID: "납부완료",
  CANCELLED: "취소됨",
  FAILED: "실패",
  PENDING: "처리중",
};

function kstDateTime(ts: unknown): string {
  if (!(ts instanceof Timestamp)) return "";
  const d = new Date(ts.toMillis() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export const PAYMENT_CSV_COLUMNS: readonly CsvColumn<PaymentCsvRow>[] = [
  { header: "결제 일시", value: (r) => kstDateTime(r.createdAt) },
  { header: "학생", value: (r) => r.studentName || "" },
  { header: "종류", value: (r) => (r.paymentType === "session_based" ? "회차" : "월정액") },
  {
    header: "납부 달/회차",
    value: (r) =>
      r.paymentType === "session_based"
        ? r.sessionCount != null ? `${r.sessionCount}회` : ""
        : r.invoicePeriod ?? "",
  },
  { header: "금액", value: (r) => (typeof r.amount === "number" ? r.amount : "") },
  { header: "상태", value: (r) => STATUS_LABEL[r.status] ?? String(r.status ?? "") },
  { header: "취소 일시", value: (r) => kstDateTime(r.cancelledAt) },
  { header: "결제 번호", value: (r) => r.paymentId || r.id },
  { header: "거래 번호", value: (r) => r.portoneTransactionId ?? "" },
];

function yyyymmdd(): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** 파일 이름에 쓸 수 없는 문자를 뺀 학원 이름 */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "학원";
}

export function paymentsCsvFileName(academyName: string, suffix?: string): string {
  return `결제내역_${safeName(academyName)}${suffix ? `_${suffix}` : ""}_${yyyymmdd()}.csv`;
}

/** 학원 결제 기록 전체(또는 기간)를 읽어 CSV로 내려받음 — 내려받은 건수(0이면 파일 없음) */
export async function downloadAcademyPaymentsCsv(
  academyId: string,
  academyName: string,
  range?: { start: Timestamp; end: Timestamp; suffix: string },
): Promise<number> {
  const col = collection(getFirebaseDb(), academyPaymentsPath(academyId));
  const q = range
    ? query(col, where("createdAt", ">=", range.start), where("createdAt", "<", range.end), orderBy("createdAt", "desc"))
    : query(col, orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as AcademyPaymentDoc) }));
  if (rows.length === 0) return 0;
  downloadCsv(paymentsCsvFileName(academyName, range?.suffix), PAYMENT_CSV_COLUMNS, rows);
  return rows.length;
}
