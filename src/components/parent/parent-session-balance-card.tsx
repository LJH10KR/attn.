"use client";

import PortOne from "@portone/browser-sdk/v2";
import { useState } from "react";

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
  weeklySessionCount: number;
  pricePerSession: number | null;
  sessionBalance: number | null;
  extraSessionDates: string[];
  settings: TuitionSettings | null;
  onRefreshAction: () => void;
};

export function ParentSessionBalanceCard({
  studentId,
  studentName,
  academyId,
  weeklySessionCount,
  pricePerSession,
  sessionBalance,
  extraSessionDates,
  settings,
  onRefreshAction,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [paying, setPaying] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  const balance = sessionBalance ?? 0;
  const isLow = balance <= weeklySessionCount;
  const isNegative = balance < 0;
  const extraCount = extraSessionDates.length;
  const debtSessions = Math.max(0, -balance);
  const monthlySessionCount = weeklySessionCount * 4;
  // 충전 결제 시 결제할 회차 수 — 권장 납부 금액과 동일한 산식(다음 4주 + 초과 부채)
  const chargeSessionCount = monthlySessionCount + debtSessions;

  let statusLabel: string;
  let statusColorClass: string;
  if (balance < 0) {
    statusLabel = "초과 발생";
    statusColorClass = "text-red-700 dark:text-red-400 bg-red-100/70 dark:bg-red-900/40";
  } else if (balance === 0) {
    statusLabel = "잔여 없음";
    statusColorClass = "text-red-700 dark:text-red-400 bg-red-100/70 dark:bg-red-900/40";
  } else if (balance <= weeklySessionCount) {
    statusLabel = "잔여 부족";
    statusColorClass = "text-amber-700 dark:text-amber-400 bg-amber-100/70 dark:bg-amber-900/40";
  } else {
    statusLabel = "충분";
    statusColorClass = "text-violet-700 dark:text-violet-400 bg-violet-100/70 dark:bg-violet-900/30";
  }

  let balanceColorClass: string;
  if (balance < 0) balanceColorClass = "font-semibold text-red-700 dark:text-red-400";
  else if (balance === 0) balanceColorClass = "font-semibold text-red-700 dark:text-red-400";
  else if (balance <= weeklySessionCount) balanceColorClass = "font-medium text-amber-800 dark:text-amber-300";
  else balanceColorClass = "font-medium text-violet-950 dark:text-violet-100";

  const suggestedAmount =
    pricePerSession != null
      ? (monthlySessionCount + debtSessions) * pricePerSession
      : null;

  const hasBankInfo = settings?.bankName || settings?.accountNumber || settings?.accountHolder;
  const accountText = [settings?.bankName, settings?.accountNumber, settings?.accountHolder]
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

  const onCardCharge = async () => {
    if (paying || pricePerSession == null || pricePerSession <= 0) return;

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
      const totalAmount = pricePerSession * chargeSessionCount;
      const redirectUrl = new URL("/payment/complete", window.location.origin);
      redirectUrl.searchParams.set("studentId", studentId);
      redirectUrl.searchParams.set("academyId", academyId);
      redirectUrl.searchParams.set("paymentType", "session_based");
      redirectUrl.searchParams.set("sessionCount", String(chargeSessionCount));

      const payment = await PortOne.requestPayment({
        storeId,
        channelKey,
        paymentId,
        orderName: `${studentName} 학생 회차 충전 (${chargeSessionCount}회)`,
        totalAmount,
        currency: "KRW",
        payMethod: "CARD",
        windowType: { pc: "IFRAME", mobile: "REDIRECTION" },
        redirectUrl: redirectUrl.toString(),
        // 사용자가 /payment/complete로 돌아오지 못해도 웹훅이 이 값으로 독립적으로
        // 결제를 완결할 수 있도록 결제 건 자체에 실어 보낸다.
        customData: {
          studentId,
          academyId,
          paymentType: "session_based",
          sessionCount: chargeSessionCount,
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
          paymentType: "session_based",
          sessionCount: chargeSessionCount,
        }),
      });

      if (!verifyRes.ok) {
        const data = (await verifyRes.json().catch(() => null)) as { error?: string } | null;
        setPaymentError(data?.error || "결제 검증에 실패했습니다.");
        return;
      }

      onRefreshAction();
    } catch (err) {
      console.error("[ParentSessionBalanceCard] 결제 처리 실패", err);
      setPaymentError("결제 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPaying(false);
    }
  };

  return (
    <div className="mt-3 rounded-2xl bg-violet-50/80 dark:bg-violet-900/20 ring-1 ring-violet-200/70 dark:ring-violet-700/40 p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${statusColorClass}`}>
          {statusLabel}
        </span>
        <p className="text-xs font-medium text-violet-900 dark:text-violet-200">
          회차 수업 현황
        </p>
      </div>

      <div className="space-y-0.5">
        <p className="text-[11px] text-violet-800 dark:text-violet-300">
          잔여 횟수{" "}
          <span className={balanceColorClass}>
            {balance >= 0 ? `${balance}회` : `0회 (초과 ${-balance}회)`}
          </span>
        </p>
        <p className="text-[11px] text-violet-800 dark:text-violet-300">
          주당 수업{" "}
          <span className="font-medium text-violet-950 dark:text-violet-100">
            {weeklySessionCount}회
          </span>
        </p>
        {pricePerSession != null ? (
          <p className="text-[11px] text-violet-800 dark:text-violet-300">
            회당 금액{" "}
            <span className="font-medium text-violet-950 dark:text-violet-100">
              {pricePerSession.toLocaleString("ko-KR")}원
            </span>
          </p>
        ) : null}
        {extraCount > 0 ? (
          <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
            초과 수업일:{" "}
            {extraSessionDates.slice(-3).join(", ")}
            {extraCount > 3 ? ` 외 ${extraCount - 3}건` : ""}
          </p>
        ) : null}
      </div>

      {isLow ? (
        <>
          {suggestedAmount != null ? (
            <div className="rounded-xl bg-white/60 dark:bg-white/10 px-3 py-2.5">
              <p className="text-[10px] text-neutral-500 dark:text-neutral-400">
                {isNegative
                  ? `다음 4주 수업료(${monthlySessionCount}회) + 초과 수업료(${debtSessions}회)`
                  : `다음 4주 수업료 (${monthlySessionCount}회)`}
              </p>
              <p className="mt-0.5 text-sm font-semibold text-foreground">
                {suggestedAmount.toLocaleString("ko-KR")}원
              </p>
            </div>
          ) : null}

          {pricePerSession != null && pricePerSession > 0 ? (
            <button
              type="button"
              onClick={() => void onCardCharge()}
              disabled={paying}
              className="flex items-center justify-center w-full rounded-[8px] bg-indigo-600 py-2.5 text-xs font-semibold text-white hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {paying ? "결제 진행 중…" : "카드로 충전하기"}
            </button>
          ) : null}

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

          {hasBankInfo ? (
            <div className="flex items-center justify-between gap-2 rounded-xl bg-white/60 dark:bg-white/10 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-[10px] text-neutral-500 dark:text-neutral-400">계좌번호</p>
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
        </>
      ) : null}
    </div>
  );
}
