"use client";

import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { HomeTabIcon } from "@/components/dashboard/attn-tab-logo";
import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";
import { DashboardRoleHeader } from "@/components/dashboard/dashboard-role-header";
import {
  academyPaymentsPath,
  type AcademyPaymentDoc,
  type AcademyPaymentStatus,
} from "@/lib/firebase/attn-schema";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";
import { fetchIsOwner } from "@/lib/firebase/owner-profile";

const glassCard = "glass-card";

function nowKST(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date());
  return {
    year: Number(parts.find((p) => p.type === "year")?.value ?? new Date().getFullYear()),
    month: Number(parts.find((p) => p.type === "month")?.value ?? new Date().getMonth() + 1),
  };
}

function kstMonthBounds(year: number, month: number): { start: Timestamp; end: Timestamp } {
  const KST = 9 * 60 * 60 * 1000;
  return {
    start: Timestamp.fromMillis(Date.UTC(year, month - 1, 1) - KST),
    end: Timestamp.fromMillis(Date.UTC(year, month, 1) - KST),
  };
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

function AcademyPaymentsInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { profile: authProfile } = useAuthProfile();
  const academyId = searchParams.get("id")?.trim() ?? "";

  const [gate, setGate] = useState<"loading" | "auth" | "forbidden" | "ok">("loading");
  const [year, setYear] = useState(() => nowKST().year);
  const [month, setMonth] = useState(() => nowKST().month);
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [loadingRows, setLoadingRows] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured()) {
      setGate("auth");
      return;
    }
    const auth = getFirebaseAuth();
    return onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setGate("auth");
        return;
      }
      if (!academyId) {
        setGate("forbidden");
        return;
      }
      try {
        const token = await user.getIdTokenResult();
        const role = token.claims.role;
        const claimAcademy = token.claims.academyId;
        const isPortal = role === "academy" && claimAcademy === academyId;
        const ownerOk = role !== "academy" && (await fetchIsOwner(user.uid));
        if (!isPortal && !ownerOk) {
          setGate("forbidden");
          return;
        }
        setGate("ok");
      } catch {
        setGate("forbidden");
      }
    });
  }, [academyId]);

  useEffect(() => {
    if (gate !== "ok" || !academyId) return;
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
  }, [gate, academyId, year, month]);

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

  if (gate === "loading") {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center">
        <p className="text-sm text-neutral-500">불러오는 중…</p>
      </div>
    );
  }

  if (gate === "auth") {
    router.replace("/login");
    return null;
  }

  if (gate === "forbidden" || !academyId) {
    return (
      <div className="min-h-[100dvh] bg-background px-4 py-16 flex flex-col items-center justify-center">
        <p className="text-sm text-neutral-600 text-center">결제 내역에 접근할 수 없습니다.</p>
        <Link href="/academy" className="mt-4 text-sm underline">
          대시보드로
        </Link>
      </div>
    );
  }

  const backHref = `/academy?id=${encodeURIComponent(academyId)}`;
  const kst = nowKST();
  const isCurrentMonth = year === kst.year && month === kst.month;

  return (
    <div className="min-h-[100dvh] bg-background pb-28">
      <DashboardRoleHeader
        title="결제 내역"
        affiliationLabel="원비 결제"
        profile={authProfile}
        showBack
        onBackAction={() => router.back()}
        backAriaLabel="학원 대시보드로"
        onHomeAction={() => router.push("/")}
        onLogoutAction={() => router.push(backHref)}
        logoutLabel="닫기"
        bottomTabs={[
          {
            id: "home",
            label: "요약",
            showLabel: false,
            iconAction: (active: boolean) => <HomeTabIcon active={active} />,
            active: true,
            onSelectAction: () => router.push(backHref),
          },
        ]}
      />

      <main className="mx-auto max-w-lg px-4 pt-[26px] space-y-4">
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
                {r.status === "PAID" ? (
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
      </main>

      <DashboardBottomScrim />
    </div>
  );
}

export default function AcademyPaymentsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-[100dvh] bg-background flex items-center justify-center">
          <p className="text-sm text-neutral-500">불러오는 중…</p>
        </div>
      }
    >
      <AcademyPaymentsInner />
    </Suspense>
  );
}
