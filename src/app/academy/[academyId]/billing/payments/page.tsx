"use client";

import {
  collection,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { useCallback, useEffect, useState } from "react";
import { useAcademyShell } from "@/components/academy/academy-shell";
import { kstMonthBounds, nowKST } from "@/lib/academy/kst-month";
import {
  academyPaymentsPath,
  type AcademyPaymentDoc,
  type AcademyPaymentStatus,
} from "@/lib/firebase/attn-schema";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client-app";

const glassCard = "glass-card";

function fmtDateTime(ts: Timestamp | undefined): string {
  if (!ts) return "-";
  return ts.toDate().toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "short",
    timeStyle: "short",
  });
}

const STATUS_LABEL: Record<AcademyPaymentStatus, string> = {
  PAID: "납부완료",
  CANCELLED: "취소됨",
  FAILED: "실패",
  PENDING: "처리중",
};

const STATUS_BADGE_CLASS: Record<AcademyPaymentStatus, string> = {
  PAID: "bg-emerald-500/15 text-emerald-900",
  CANCELLED: "bg-neutral-500/15 text-neutral-700",
  FAILED: "bg-red-500/15 text-red-800",
  PENDING: "bg-amber-500/20 text-amber-900",
};

type PaymentRow = AcademyPaymentDoc & { id: string };

/** 미설정 시(구 데이터) monthly_fixed로 취급 */
function paymentTypeLabel(r: PaymentRow): string {
  if (r.paymentType === "session_based") {
    return `회차 ${r.sessionCount ?? "?"}회`;
  }
  // 청구서 도입 이후 결제는 납부한 달 표시
  return r.invoicePeriod ? `월정액 · ${Number(r.invoicePeriod.slice(5))}월분` : "월정액";
}

function paymentTypeBadgeClass(r: PaymentRow): string {
  return r.paymentType === "session_based"
    ? "bg-violet-500/15 text-violet-900"
    : "bg-sky-500/15 text-sky-900";
}

/** 수납 › 결제 내역 — 권한(`billing.payments`) 확인은 학원 공통 레이아웃이 한다 */
export default function AcademyPaymentsPage() {
  const { academyId, permissions } = useAcademyShell();
  const canRefund = permissions.can("billing.refunds");

  const [year, setYear] = useState(() => nowKST().year);
  const [month, setMonth] = useState(() => nowKST().month);
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [loadingRows, setLoadingRows] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setLoadingRows(true);
    setLoadError(null);
    const db = getFirebaseDb();
    const { start, end } = kstMonthBounds(year, month);
    const qy = query(
      collection(db, academyPaymentsPath(academyId)),
      where("createdAt", ">=", start),
      where("createdAt", "<", end),
      orderBy("createdAt", "desc"),
    );
    const unsub = onSnapshot(
      qy,
      (snap) => {
        setLoadError(null);
        setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as AcademyPaymentDoc) })));
        setLoadingRows(false);
      },
      (err) => {
        setLoadError(err.message || "결제 내역을 불러오지 못했습니다.");
        setLoadingRows(false);
      },
    );
    return () => unsub();
  }, [academyId, year, month]);

  const goMonth = useCallback(
    (delta: -1 | 1) => {
      const kst = nowKST();
      let newYear = year;
      let newMonth = month + delta;
      if (newMonth < 1) {
        newYear -= 1;
        newMonth = 12;
      } else if (newMonth > 12) {
        newYear += 1;
        newMonth = 1;
      }
      if (newYear > kst.year || (newYear === kst.year && newMonth > kst.month)) return;
      setYear(newYear);
      setMonth(newMonth);
    },
    [month, year],
  );

  const onCancel = useCallback(
    async (paymentId: string) => {
      if (cancellingId) return;
      setCancellingId(paymentId);
      setActionError(null);
      try {
        const user = getFirebaseAuth().currentUser;
        if (!user) throw new Error("로그인 상태를 확인해 주세요.");
        const idToken = await user.getIdToken();
        const res = await fetch("/api/payment/cancel", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ paymentId, academyId }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error || "결제 취소에 실패했습니다.");
        }
        // 취소 성공 후 상태는 onSnapshot 구독을 통해 자동 반영됨
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "결제 취소에 실패했습니다.");
      } finally {
        setCancellingId(null);
      }
    },
    [academyId, cancellingId],
  );

  const kst = nowKST();
  const isCurrentMonth = year === kst.year && month === kst.month;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => goMonth(-1)}
          className="rounded-[8px] border border-neutral-300/70 bg-white/55 px-3 py-1.5 text-xs font-medium hover:bg-white/90"
        >
          ‹ 이전
        </button>
        <span className="min-w-[90px] text-center text-sm font-semibold text-foreground">
          {year}년 {month}월
        </span>
        <button
          type="button"
          onClick={() => goMonth(1)}
          disabled={isCurrentMonth}
          className="rounded-[8px] border border-neutral-300/70 bg-white/55 px-3 py-1.5 text-xs font-medium hover:bg-white/90 disabled:opacity-40"
        >
          다음 ›
        </button>
      </div>

      {loadError ? (
        <p className="rounded-2xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
          {loadError}
        </p>
      ) : null}
      {actionError ? (
        <p className="rounded-2xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
          {actionError}
        </p>
      ) : null}

      {loadingRows ? (
        <p className={`py-12 text-center text-sm text-neutral-500 ${glassCard}`}>
          불러오는 중…
        </p>
      ) : rows.length === 0 ? (
        <p className={`py-12 text-center text-sm text-neutral-500 ${glassCard}`}>
          이 달의 결제 내역이 없습니다.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className={`p-3 ${glassCard}`}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_BADGE_CLASS[r.status]}`}
                >
                  {STATUS_LABEL[r.status]}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${paymentTypeBadgeClass(r)}`}
                >
                  {paymentTypeLabel(r)}
                </span>
                <span className="text-xs font-medium text-foreground">
                  {r.studentName || "학생"}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-neutral-600">
                납부일시 {fmtDateTime(r.createdAt)}
              </p>
              <p className="mt-0.5 text-[11px] text-neutral-600">
                금액{" "}
                <span className="font-medium text-foreground">
                  {r.amount.toLocaleString("ko-KR")}원
                </span>
              </p>
              {r.status === "CANCELLED" && r.cancelledAt ? (
                <p className="mt-0.5 text-[11px] text-neutral-500">
                  취소일시 {fmtDateTime(r.cancelledAt)}
                </p>
              ) : null}
              {r.status === "PAID" && canRefund ? (
                <button
                  type="button"
                  onClick={() => void onCancel(r.paymentId)}
                  disabled={cancellingId === r.paymentId}
                  className="mt-2 rounded-[8px] border border-red-300/70 bg-red-50/70 px-3 py-1.5 text-[11px] font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                >
                  {cancellingId === r.paymentId ? "취소 중…" : "결제 취소"}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
