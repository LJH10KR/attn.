import { FirebaseError } from "firebase/app";
import { collection, getDocs, limit, orderBy, query } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { academyStudentTuitionInvoicesPath } from "@/lib/firebase/attn-schema";
import { getFirebaseDb, getFirebaseFunctions } from "@/lib/firebase/client-app";
import {
  computeInvoiceFinalAmount,
  formatInvoicePeriod,
  invoiceDueDate,
  nextDueInvoicePeriod,
  shiftInvoicePeriod,
} from "@/lib/payment/tuition-invoice";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

const HISTORY_LIMIT = 8;
const MAX_MEMO_LENGTH = 100;

const inputClass =
  "min-w-0 w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-3 py-2 text-sm text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50 focus:bg-white/70";

type Adjustment = { id: string; amount: number; memo: string };

type InvoiceRow = {
  period: string;
  status: "open" | "paid";
  adjustments: Adjustment[];
  baseAmount: number | null;
  finalAmount: number | null;
  paidMethod: "card" | "manual" | null;
};

function parseInvoice(period: string, x: Record<string, unknown>): InvoiceRow {
  const adjustments = Array.isArray(x.adjustments)
    ? (x.adjustments as unknown[]).flatMap((a) => {
        const v = a as { id?: unknown; amount?: unknown; memo?: unknown } | null;
        if (!v || typeof v.id !== "string" || typeof v.amount !== "number") return [];
        return [{ id: v.id, amount: v.amount, memo: typeof v.memo === "string" ? v.memo : "" }];
      })
    : [];
  return {
    period,
    status: x.status === "paid" ? "paid" : "open",
    adjustments,
    baseAmount: typeof x.baseAmount === "number" ? x.baseAmount : null,
    finalAmount: typeof x.finalAmount === "number" ? x.finalAmount : null,
    paidMethod: x.paidMethod === "card" || x.paidMethod === "manual" ? x.paidMethod : null,
  };
}

function won(n: number): string {
  return `${n.toLocaleString("ko-KR")}원`;
}

function signedWon(n: number): string {
  return `${n > 0 ? "+" : "−"}${Math.abs(n).toLocaleString("ko-KR")}원`;
}

function errMessage(e: unknown, fallback: string): string {
  return e instanceof FirebaseError && e.message ? e.message : fallback;
}

/**
 * 원장·학원 포털 — 매월 지정일 납부 학생의 청구서 관리.
 * 이번 청구서(다음 납부 달, 이미 납부됐으면 그다음 달)에 차감·추가 조정을 넣고,
 * 계좌이체·현금 등 카드 외 납부는 직접 납부 완료로 표시.
 */
export function TuitionInvoiceModal({
  academyId,
  studentId,
  studentName,
  tuitionAmount,
  tuitionDueDayOfMonth,
  onClose,
  onNotice,
}: {
  academyId: string;
  studentId: string;
  studentName: string;
  tuitionAmount: number;
  tuitionDueDayOfMonth: number;
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const [invoices, setInvoices] = useState<Record<string, InvoiceRow>>({});
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sign, setSign] = useState<-1 | 1>(-1);
  const [amountText, setAmountText] = useState("");
  const [memo, setMemo] = useState("");
  const [confirm, setConfirm] = useState<{ period: string; paid: boolean } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useBodyScrollLock(true);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !actionBusy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actionBusy, onClose]);

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    try {
      const snap = await getDocs(
        query(
          collection(getFirebaseDb(), academyStudentTuitionInvoicesPath(academyId, studentId)),
          orderBy("period", "desc"),
          limit(HISTORY_LIMIT),
        ),
      );
      const next: Record<string, InvoiceRow> = {};
      snap.docs.forEach((d) => {
        next[d.id] = parseInvoice(d.id, d.data());
      });
      setInvoices(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "청구서를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [academyId, studentId]);

  useEffect(() => {
    void fetchInvoices();
  }, [fetchInvoices]);

  const nextPeriod = nextDueInvoicePeriod(tuitionDueDayOfMonth);
  const nextPaid = invoices[nextPeriod]?.status === "paid";
  // 이번 납부가 끝났으면 조정은 다음 달 청구서에 반영
  const targetPeriod = nextPaid ? shiftInvoicePeriod(nextPeriod, 1) : nextPeriod;
  const target: InvoiceRow = invoices[targetPeriod] ?? {
    period: targetPeriod,
    status: "open",
    adjustments: [],
    baseAmount: null,
    finalAmount: null,
    paidMethod: null,
  };
  const targetFinal = computeInvoiceFinalAmount(tuitionAmount, target.adjustments);
  const manageable = useMemo(
    () => new Set([shiftInvoicePeriod(nextPeriod, -1), nextPeriod, shiftInvoicePeriod(nextPeriod, 1)]),
    [nextPeriod],
  );
  const history = Object.values(invoices)
    .filter((r) => r.period !== targetPeriod)
    .sort((a, b) => (a.period < b.period ? 1 : -1));

  const parsedAmount = Number(amountText.replace(/[^\d]/g, ""));
  const canAdd =
    !actionBusy && Number.isInteger(parsedAmount) && parsedAmount > 0 && memo.trim().length > 0;

  const callAction = async (name: string, data: Record<string, unknown>, done: string) => {
    setActionBusy(true);
    setError(null);
    try {
      await httpsCallable(getFirebaseFunctions(), name)({ academyId, studentId, ...data });
      onNotice(done);
      await fetchInvoices();
      return true;
    } catch (e) {
      setError(errMessage(e, "처리하지 못했습니다. 잠시 후 다시 시도해 주세요."));
      return false;
    } finally {
      setActionBusy(false);
    }
  };

  const addAdjustment = async () => {
    if (!canAdd) return;
    const ok = await callAction(
      "addTuitionInvoiceAdjustment",
      { period: targetPeriod, amount: sign * parsedAmount, memo: memo.trim() },
      `${studentName} ${formatInvoicePeriod(targetPeriod)} 청구서에 ${signedWon(sign * parsedAmount)}을 반영했습니다.`,
    );
    if (ok) {
      setAmountText("");
      setMemo("");
    }
  };

  const setManualPaid = async (period: string, paid: boolean) => {
    const ok = await callAction(
      "setTuitionInvoiceManualPaid",
      { period, paid },
      paid
        ? `${studentName} ${formatInvoicePeriod(period)} 원비를 납부 완료로 표시했습니다.`
        : `${studentName} ${formatInvoicePeriod(period)} 납부 완료 표시를 되돌렸습니다.`,
    );
    if (ok) setConfirm(null);
  };

  const confirmButtons = (period: string, paid: boolean, label: string) =>
    confirm?.period === period && confirm.paid === paid ? (
      <span className="flex shrink-0 gap-1">
        <button
          type="button"
          disabled={actionBusy}
          className="rounded-[8px] border border-neutral-300/70 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-neutral-700 disabled:opacity-50"
          onClick={() => setConfirm(null)}
        >
          아니요
        </button>
        <button
          type="button"
          disabled={actionBusy}
          className="rounded-[8px] bg-[#222] dark:bg-neutral-100 px-2.5 py-1 text-[11px] font-semibold text-white dark:text-neutral-950 disabled:opacity-50"
          onClick={() => void setManualPaid(period, paid)}
        >
          {actionBusy ? "처리 중…" : "확인"}
        </button>
      </span>
    ) : (
      <button
        type="button"
        disabled={actionBusy}
        className="shrink-0 rounded-[8px] border border-neutral-300/70 bg-white/70 px-2.5 py-1 text-[11px] font-medium text-neutral-700 hover:bg-white/90 disabled:opacity-40"
        onClick={() => setConfirm({ period, paid })}
      >
        {label}
      </button>
    );

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={() => {
        if (!actionBusy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tuition-invoice-title"
        className="glass-card flex w-full max-w-lg flex-col shadow-2xl"
        style={{ maxHeight: "min(90dvh, 720px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-neutral-200/60 px-5 py-4 dark:border-white/10">
          <div className="min-w-0">
            <h2 id="tuition-invoice-title" className="text-base font-semibold text-foreground">
              {studentName} · 원비 청구
            </h2>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              매월 {tuitionDueDayOfMonth}일 · 원비 {won(tuitionAmount)}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-[8px] border border-neutral-300/80 bg-white/70 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-white/90"
          >
            닫기
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {error ? (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
          ) : null}

          {loading ? (
            <p className="py-12 text-center text-sm text-neutral-400">불러오는 중…</p>
          ) : (
            <>
              <section className="rounded-2xl bg-white/50 px-4 py-3 dark:bg-white/[0.06]">
                {nextPaid ? (
                  <p className="mb-2 text-[11px] text-emerald-700 dark:text-emerald-300">
                    {formatInvoicePeriod(nextPeriod)} 원비는 납부 완료되어, 조정은 다음 달 청구서에 반영됩니다.
                  </p>
                ) : null}
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    {formatInvoicePeriod(targetPeriod)} 청구서
                  </h3>
                  <span className="text-[11px] text-neutral-500">
                    납부일 {invoiceDueDate(targetPeriod, tuitionDueDayOfMonth).slice(5).replace("-", ".")}
                  </span>
                </div>

                <ul className="mt-2 space-y-1 text-xs">
                  <li className="flex justify-between text-neutral-700 dark:text-neutral-300">
                    <span>원비</span>
                    <span>{won(tuitionAmount)}</span>
                  </li>
                  {target.adjustments.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-neutral-700 dark:text-neutral-300">
                        {a.memo}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className={a.amount < 0 ? "text-amber-700" : "text-sky-700"}>
                          {signedWon(a.amount)}
                        </span>
                        <button
                          type="button"
                          disabled={actionBusy}
                          aria-label={`${a.memo} 조정 삭제`}
                          className="rounded-[6px] border border-red-200/80 px-1.5 py-0.5 text-[10px] text-red-600 hover:bg-red-50 disabled:opacity-40"
                          onClick={() =>
                            void callAction(
                              "removeTuitionInvoiceAdjustment",
                              { period: targetPeriod, adjustmentId: a.id },
                              `조정 항목(${a.memo})을 삭제했습니다.`,
                            )
                          }
                        >
                          삭제
                        </button>
                      </span>
                    </li>
                  ))}
                  <li className="flex justify-between border-t border-neutral-200/70 pt-1.5 font-semibold text-foreground dark:border-white/10">
                    <span>청구 금액</span>
                    <span>{won(targetFinal)}</span>
                  </li>
                </ul>
                {tuitionAmount + target.adjustments.reduce((s, a) => s + a.amount, 0) < 0 ? (
                  <p className="mt-1 text-[11px] text-amber-700">
                    차감액이 원비보다 커서 0원으로 청구됩니다. 남는 금액은 이월되지 않습니다.
                  </p>
                ) : null}

                <div className="mt-3 space-y-2 border-t border-neutral-200/70 pt-3 dark:border-white/10">
                  <p className="text-xs font-semibold text-foreground">조정 추가</p>
                  <div className="flex gap-1.5">
                    {([-1, 1] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        disabled={actionBusy}
                        aria-pressed={sign === s}
                        onClick={() => setSign(s)}
                        className={`shrink-0 rounded-[10px] border px-3 py-2 text-xs font-medium disabled:opacity-50 ${
                          sign === s
                            ? "border-neutral-700 bg-neutral-800 text-white dark:border-neutral-200 dark:bg-neutral-100 dark:text-neutral-950"
                            : "border-neutral-300/70 bg-white/55 text-foreground hover:bg-white/90"
                        }`}
                      >
                        {s < 0 ? "차감" : "추가"}
                      </button>
                    ))}
                    <input
                      type="text"
                      inputMode="numeric"
                      className={inputClass}
                      placeholder="금액(원)"
                      value={amountText ? Number(amountText.replace(/[^\d]/g, "")).toLocaleString("ko-KR") : ""}
                      disabled={actionBusy}
                      onChange={(e) => setAmountText(e.target.value.replace(/[^\d]/g, "").slice(0, 8))}
                    />
                  </div>
                  <input
                    type="text"
                    className={inputClass}
                    placeholder="사유 (학부모 납부 화면에 표시) 예: 10월 질병 결석 3일"
                    maxLength={MAX_MEMO_LENGTH}
                    value={memo}
                    disabled={actionBusy}
                    onChange={(e) => setMemo(e.target.value)}
                  />
                  <button
                    type="button"
                    disabled={!canAdd}
                    onClick={() => void addAdjustment()}
                    className="w-full rounded-2xl bg-[#222] dark:bg-neutral-100 px-4 py-2.5 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-50"
                  >
                    {actionBusy ? "처리 중…" : "청구서에 반영"}
                  </button>
                </div>

                <div className="mt-3 flex items-center justify-between gap-2 border-t border-neutral-200/70 pt-3 dark:border-white/10">
                  <p className="text-[11px] text-neutral-600 dark:text-neutral-400">
                    계좌이체·현금 등으로 받으셨나요?
                  </p>
                  {confirmButtons(targetPeriod, true, "납부 완료로 표시")}
                </div>
              </section>

              <section>
                <h3 className="mb-1.5 text-xs font-semibold text-foreground">청구 이력</h3>
                {history.length === 0 ? (
                  <p className="py-4 text-center text-[11px] text-neutral-400">
                    조정·납부 기록이 있는 청구서가 여기에 표시됩니다.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {history.map((r) => {
                      const amount =
                        r.status === "paid" && r.finalAmount != null
                          ? r.finalAmount
                          : computeInvoiceFinalAmount(tuitionAmount, r.adjustments);
                      return (
                        <li
                          key={r.period}
                          className="flex items-center justify-between gap-2 rounded-xl bg-white/50 px-3 py-2 dark:bg-white/[0.06]"
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-xs font-medium text-foreground">
                                {formatInvoicePeriod(r.period)}
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                  r.status === "paid"
                                    ? "bg-emerald-500/15 text-emerald-900 dark:text-emerald-200"
                                    : "bg-amber-500/20 text-amber-900 dark:text-amber-200"
                                }`}
                              >
                                {r.status === "paid"
                                  ? r.paidMethod === "manual"
                                    ? "납부 완료 · 직접 확인"
                                    : "납부 완료 · 카드"
                                  : "납부 미확인"}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[11px] text-neutral-600">
                              {won(amount)}
                              {r.adjustments.length > 0 ? ` · 조정 ${r.adjustments.length}건` : ""}
                            </p>
                          </div>
                          {manageable.has(r.period)
                            ? r.status === "paid"
                              ? r.paidMethod === "manual"
                                ? confirmButtons(r.period, false, "되돌리기")
                                : null
                              : confirmButtons(r.period, true, "납부 완료로 표시")
                            : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
