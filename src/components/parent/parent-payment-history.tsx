"use client";

import {
  collection,
  getDocs,
  orderBy,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { useEffect, useState } from "react";
import {
  academyPaymentsPath,
  type AcademyPaymentDoc,
  type AcademyPaymentStatus,
} from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";

const glassCard = "glass-card";

function threeMonthsAgoTimestamp(): Timestamp {
  const d = new Date();
  d.setMonth(d.getMonth() - 3);
  return Timestamp.fromDate(d);
}

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

type Props = {
  academyId: string | null;
  parentUid: string | null;
};

export function ParentPaymentHistory({ academyId, parentUid }: Props) {
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!academyId || !parentUid) {
      setRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const db = getFirebaseDb();
    const qy = query(
      collection(db, academyPaymentsPath(academyId)),
      where("parentUserId", "==", parentUid),
      where("createdAt", ">=", threeMonthsAgoTimestamp()),
      orderBy("createdAt", "desc"),
    );
    void (async () => {
      try {
        const snap = await getDocs(qy);
        if (cancelled) return;
        setError(null);
        setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as AcademyPaymentDoc) })));
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "납부 내역을 불러오지 못했습니다.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyId, parentUid]);

  if (!academyId || !parentUid) return null;

  return (
    <div className="mt-[26px]">
      <h2 className="mb-3 text-sm font-semibold text-foreground">납부 내역</h2>

      {error ? (
        <p className="rounded-2xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
          {error}
        </p>
      ) : loading ? (
        <p className={`py-10 text-center text-sm text-neutral-500 ${glassCard}`}>
          불러오는 중…
        </p>
      ) : rows.length === 0 ? (
        <p className={`py-10 text-center text-sm text-neutral-500 ${glassCard}`}>
          최근 3개월간 납부 내역이 없습니다.
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
