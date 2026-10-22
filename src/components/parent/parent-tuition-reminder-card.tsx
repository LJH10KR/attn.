"use client";

import PortOne from "@portone/browser-sdk/v2";
import { useMemo, useState } from "react";
import type { TuitionInvoiceSummary } from "@/lib/firebase/attn-schema";

const DAY_MS = 24 * 60 * 60 * 1000;

function seoulMidnightMs(date: Date): number {
  const dateStr = date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  return new Date(`${dateStr}T00:00:00+09:00`).getTime();
}

function getNextDueDateMs(dueDayOfMonth: number, todayMidnightMs: number): number {
  const todayStr = new Date(todayMidnightMs).toLocaleDateString("en-CA", {
    timeZone: "Asia/Seoul",
  });
  const [y, m] = todayStr.split("-").map(Number) as [number, number];

  const daysInCurrent = new Date(y, m, 0).getDate();
  const currentDay = Math.min(dueDayOfMonth, daysInCurrent);
  const currentDueMs = new Date(
    `${y}-${String(m).padStart(2, "0")}-${String(currentDay).padStart(2, "0")}T00:00:00+09:00`,
  ).getTime();

  if (currentDueMs >= todayMidnightMs) return currentDueMs;

  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  const daysInNext = new Date(ny, nm, 0).getDate();
  const nextDay = Math.min(dueDayOfMonth, daysInNext);
  return new Date(
    `${ny}-${String(nm).padStart(2, "0")}-${String(nextDay).padStart(2, "0")}T00:00:00+09:00`,
  ).getTime();
}

type TuitionSettings = {
  kakaoPayLink?: string;
  bankName?: string;
  accountNumber?: string;
  accountHolder?: string;
  channelKey?: string;
};

type Props = {
  studentId: string;
  studentName: string;
  academyId: string;
  tuitionDueDayOfMonth: number;
  tuitionAmount?: number | null;
  /** 다음 납부 청구서 — 청구서 도입 이전 Functions 응답이면 null(원비 그대로 청구) */
  invoice: TuitionInvoiceSummary | null;
  settings: TuitionSettings | null;
  onRefreshAction: () => void;
};

export function ParentTuitionReminderCard({
  studentId,
  studentName,
  academyId,
  tuitionDueDayOfMonth,
  tuitionAmount,
  invoice,
  settings,
  onRefreshAction,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [paying, setPaying] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paidLocally, setPaidLocally] = useState(false);

  // 조정(결석 차감 등)이 반영된 청구 금액 — 서버 검증(`completePayment`)도 같은 값으로 계산
  const amountToPay = invoice ? invoice.finalAmount : tuitionAmount ?? null;
  const paid = paidLocally || invoice?.status === "paid";
  const nothingToPay = !paid && amountToPay === 0;

  const { diffDays, dueDateLabel } = useMemo(() => {
    const todayMs = seoulMidnightMs(new Date());
    const nextDueMs = getNextDueDateMs(tuitionDueDayOfMonth, todayMs);
    const diff = Math.round((nextDueMs - todayMs) / DAY_MS);
    const label = new Date(nextDueMs).toLocaleDateString("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    return { diffDays: diff, dueDateLabel: label };
  }, [tuitionDueDayOfMonth]);

  // D-7 ~ D-0 (당일 포함) 구간에만 표시
  if (diffDays < 0 || diffDays > 7) return null;

  const diffLabel = diffDays === 0 ? "D-Day" : `D-${diffDays}`;

  const hasBankInfo =
    settings?.bankName || settings?.accountNumber || settings?.accountHolder;
  const accountText = [
    settings?.bankName,
    settings?.accountNumber,
    settings?.accountHolder,
  ]
    .filter(Boolean)
    .join(" · ");

  const onCopy = async () => {
    if (!settings?.accountNumber) return;
    try {
      await navigator.clipboard.writeText(settings.accountNumber);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const onCardPayment = async () => {
    if (paying || amountToPay == null || amountToPay <= 0) return;

    const storeId = process.env.NEXT_PUBLIC_PORTONE_STORE_ID;
    // Firestore tuitionSettings.channelKey가 있으면 우선 사용, 없으면 공용 테스트 채널로 폴백
    const channelKey = settings?.channelKey || process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY;
    if (!storeId || !channelKey) {
      setPaymentError("결제 설정이 완료되지 않았습니다. 학원에 문의해 주세요.");
      return;
    }

    setPaying(true);
    setPaymentError(null);
    try {
      const paymentId = crypto.randomUUID();
      const redirectUrl = new URL("/payment/complete", window.location.origin);
      redirectUrl.searchParams.set("studentId", studentId);
      redirectUrl.searchParams.set("academyId", academyId);
      redirectUrl.searchParams.set("paymentType", "monthly_fixed");
      if (invoice) redirectUrl.searchParams.set("invoicePeriod", invoice.period);

      const payment = await PortOne.requestPayment({
        storeId,
        channelKey,
        paymentId,
        orderName: invoice
          ? `${studentName} 학생 ${Number(invoice.period.slice(5))}월 원비`
          : `${studentName} 학생 원비`,
        totalAmount: amountToPay,
        currency: "KRW",
        payMethod: "CARD",
        windowType: { pc: "IFRAME", mobile: "REDIRECTION" },
        redirectUrl: redirectUrl.toString(),
        // 사용자가 /payment/complete로 돌아오지 못해도 웹훅이 이 값으로 독립적으로
        // 결제를 완결할 수 있도록 결제 건 자체에 실어 보낸다.
        customData: {
          studentId,
          academyId,
          paymentType: "monthly_fixed",
          ...(invoice ? { invoicePeriod: invoice.period } : {}),
        },
      });

      // 모바일(REDIRECTION)은 이 시점에 페이지가 이미 /payment/complete로 이동해 있어
      // 아래 코드에 도달하지 않음 — 여기서부터는 PC(IFRAME) 응답 처리만 담당.
      if (!payment || payment.code) {
        setPaymentError(payment?.message || "결제가 취소되었거나 실패했습니다.");
        return;
      }
      if (!payment.paymentId) {
        setPaymentError("결제 정보를 확인하지 못했습니다.");
        return;
      }

      const verifyRes = await fetch("/api/payment/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentId,
          studentId,
          academyId,
          ...(invoice ? { invoicePeriod: invoice.period } : {}),
        }),
      });

      if (!verifyRes.ok) {
        const data = (await verifyRes.json().catch(() => null)) as { error?: string } | null;
        setPaymentError(data?.error || "결제 검증에 실패했습니다.");
        // 금액 불일치·중복 결제로 자동 취소된 경우 최신 청구 금액·납부 상태를 다시 불러옴
        onRefreshAction();
        return;
      }

      setPaidLocally(true);
      onRefreshAction();
    } catch (err) {
      console.error("[ParentTuitionReminderCard] 결제 처리 실패", err);
      setPaymentError("결제 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPaying(false);
    }
  };

  return (
    <div className="mt-3 rounded-2xl bg-amber-50/80 dark:bg-amber-900/20 ring-1 ring-amber-200/70 dark:ring-amber-700/40 p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold text-amber-800 dark:text-amber-300 bg-amber-200/60 dark:bg-amber-800/50 px-2 py-0.5 rounded-full">
          {diffLabel}
        </span>
        <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
          원비 납부 안내
        </p>
      </div>

      <div className="space-y-0.5">
        <p className="text-[11px] text-amber-800 dark:text-amber-300">
          납부 예정일{" "}
          <span className="font-medium text-amber-950 dark:text-amber-100">
            {dueDateLabel}
          </span>
        </p>
        {invoice && invoice.adjustments.length > 0 ? (
          <div className="space-y-0.5 rounded-xl bg-white/50 dark:bg-white/[0.06] px-2.5 py-2">
            <p className="flex justify-between text-[11px] text-amber-800 dark:text-amber-300">
              <span>원비</span>
              <span>{invoice.baseAmount.toLocaleString("ko-KR")}원</span>
            </p>
            {invoice.adjustments.map((a, i) => (
              <p
                key={i}
                className="flex justify-between gap-2 text-[11px] text-amber-800 dark:text-amber-300"
              >
                <span className="min-w-0 truncate">{a.memo || (a.amount < 0 ? "차감" : "추가")}</span>
                <span className="shrink-0">
                  {a.amount > 0 ? "+" : "−"}
                  {Math.abs(a.amount).toLocaleString("ko-KR")}원
                </span>
              </p>
            ))}
          </div>
        ) : null}
        {amountToPay != null ? (
          <p className="text-[11px] text-amber-800 dark:text-amber-300">
            납부 금액{" "}
            <span className="font-medium text-amber-950 dark:text-amber-100">
              {amountToPay.toLocaleString("ko-KR")}원
            </span>
          </p>
        ) : null}
      </div>

      {paid ? (
        <p className="rounded-[8px] bg-emerald-100/80 dark:bg-emerald-900/30 py-2.5 text-center text-xs font-semibold text-emerald-800 dark:text-emerald-300">
          납부가 완료되었습니다
        </p>
      ) : nothingToPay ? (
        <p className="rounded-[8px] bg-white/60 dark:bg-white/10 py-2.5 text-center text-xs font-medium text-amber-900 dark:text-amber-200">
          조정 내역이 반영되어 이번에 납부할 금액이 없습니다
        </p>
      ) : (
        <>
          <button
            type="button"
            onClick={() => void onCardPayment()}
            disabled={paying || amountToPay == null}
            className="flex items-center justify-center w-full rounded-[8px] bg-indigo-600 py-2.5 text-xs font-semibold text-white hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {paying ? "결제 진행 중…" : "카드로 납부하기"}
          </button>

          {paymentError ? (
            <p className="text-[11px] text-red-600 dark:text-red-400">{paymentError}</p>
          ) : null}

          {settings?.kakaoPayLink ? (
            <a
              href={settings.kakaoPayLink}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center w-full rounded-[8px] bg-[#FEE500] py-2.5 text-xs font-semibold text-[#3C1E1E] hover:bg-[#F6D800] active:bg-[#EDD000]"
            >
              카카오페이로 납부하기
            </a>
          ) : null}
        </>
      )}

      {hasBankInfo ? (
        <div className="flex items-center justify-between gap-2 rounded-xl bg-white/60 dark:bg-white/10 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-[10px] text-neutral-500 dark:text-neutral-400">
              계좌번호
            </p>
            <p className="mt-0.5 text-xs font-medium text-foreground truncate">
              {accountText}
            </p>
          </div>
          {settings?.accountNumber ? (
            <button
              type="button"
              onClick={() => void onCopy()}
              className="shrink-0 rounded-[8px] border border-neutral-300/70 bg-white/70 dark:bg-white/10 px-2.5 py-1.5 text-[10px] font-medium text-neutral-700 dark:text-neutral-300 hover:bg-white/90"
            >
              {copied ? "복사됨" : "복사"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
