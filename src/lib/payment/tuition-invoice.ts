/**
 * 월별 청구서(`tuitionInvoices/{YYYY-MM}`) 계산 — 클라이언트(학원·학부모 UI)와 Next 서버(결제 완결)가 공용.
 * Functions(`functions/src/tuition-invoices.ts`)에 같은 규칙이 복제되어 있으니 함께 수정할 것.
 */

const PERIOD_RE = /^(\d{4})-(\d{2})$/;

export function isValidInvoicePeriod(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const m = PERIOD_RE.exec(raw);
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

/** "2026-11" + delta개월 */
export function shiftInvoicePeriod(period: string, delta: number): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** 해당 달의 납부일 — 그 달에 없는 날짜(31일 등)는 말일로 대체 */
export function invoiceDueDate(period: string, dueDayOfMonth: number): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const day = Math.min(dueDayOfMonth, new Date(y, m, 0).getDate());
  return `${period}-${String(day).padStart(2, "0")}`;
}

/**
 * 오늘(서울) 기준 다음 납부일이 속한 달 — 납부일 당일은 이번 달, 지나면 다음 달.
 * (`tuition-reminder.ts`의 getNextDueDateMs와 동일한 기준)
 */
export function nextDueInvoicePeriod(dueDayOfMonth: number, now: Date = new Date()): string {
  const today = now.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const thisPeriod = today.slice(0, 7);
  return today <= invoiceDueDate(thisPeriod, dueDayOfMonth)
    ? thisPeriod
    : shiftInvoicePeriod(thisPeriod, 1);
}

export function sumInvoiceAdjustments(adjustments: readonly { amount: number }[]): number {
  return adjustments.reduce((acc, a) => acc + a.amount, 0);
}

/** 최종 청구 금액 = 원비 + 조정 합계 (0원 미만으로 내려가지 않음) */
export function computeInvoiceFinalAmount(
  baseAmount: number,
  adjustments: readonly { amount: number }[],
): number {
  return Math.max(0, baseAmount + sumInvoiceAdjustments(adjustments));
}

/** Firestore에서 읽은 adjustments 배열 정규화 — 형식이 틀린 항목은 버림 */
export function sanitizeInvoiceAdjustments(raw: unknown): { amount: number; memo: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const { amount, memo } = x as { amount?: unknown; memo?: unknown };
    if (typeof amount !== "number" || !Number.isInteger(amount)) return [];
    return [{ amount, memo: typeof memo === "string" ? memo : "" }];
  });
}

/** 서버(`applyAbsenceDeduction`)와 동일한 1일 차감액 상한 */
export const MAX_ABSENCE_DEDUCTION_PER_DAY = 10_000_000;

/**
 * 결석 1일 차감액 기본값 — 학생별 지정값 > 학원 고정 금액 > 학원 "원비 ÷ 월 수업일수"(10원 미만 절사).
 * 정해진 값이 없으면 null(원장이 직접 입력).
 */
export function resolveAbsenceDeductionPerDay(
  settings: {
    method?: unknown;
    perDayAmount?: unknown;
    monthlyClassDays?: unknown;
  } | null,
  tuitionAmount: number,
  studentPerDay: number | null | undefined,
): { amount: number; basis: string } | null {
  const isPositiveInt = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v > 0;
  if (isPositiveInt(studentPerDay)) {
    return { amount: studentPerDay, basis: "학생별 지정" };
  }
  if (settings?.method === "per_day" && isPositiveInt(settings.perDayAmount)) {
    return { amount: settings.perDayAmount, basis: "학원 기본값(1일 고정)" };
  }
  if (settings?.method === "divide" && isPositiveInt(settings.monthlyClassDays)) {
    const amount = Math.floor(tuitionAmount / settings.monthlyClassDays / 10) * 10;
    if (amount > 0) {
      return { amount, basis: `학원 기본값(원비 ÷ ${settings.monthlyClassDays}일)` };
    }
  }
  return null;
}

/** "2026-11" → "2026년 11월" */
export function formatInvoicePeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${y}년 ${m}월`;
}
