"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { useParentPushLifecycleResync } from "@/lib/firebase/use-parent-push-lifecycle-resync";
import { subscribeForegroundMessages } from "@/lib/firebase/web-push";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

const glassOverlay =
  "rounded-[1.75rem] border border-white/70 bg-[rgba(252,251,248,0.98)] p-6 shadow-[0_24px_80px_-20px_rgba(0,0,0,0.2)]";

type PaymentReminderPayload = {
  body: string;
  studentName: string;
  studentId: string;
  academyId: string;
  suggestedAmount?: string;
  kakaoPayLink?: string;
  bankName?: string;
  accountNumber?: string;
  accountHolder?: string;
};

function isPaymentType(type: string): boolean {
  return type === "tuition_reminder" || type === "session_payment_reminder";
}

function PaymentReminderModal({
  payload,
  onConfirmAction,
}: {
  payload: PaymentReminderPayload;
  onConfirmAction: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  useBodyScrollLock(true);

  const hasBankInfo = payload.bankName || payload.accountNumber || payload.accountHolder;
  const accountText = [payload.bankName, payload.accountNumber, payload.accountHolder]
    .filter(Boolean)
    .join(" · ");

  const onCopy = async () => {
    if (!payload.accountNumber) return;
    try {
      await navigator.clipboard.writeText(payload.accountNumber);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const onConfirm = async () => {
    setBusy(true);
    try {
      const uid = getFirebaseAuth().currentUser?.uid;
      const { academyId, studentId } = payload;
      if (uid && academyId && studentId) {
        await updateDoc(doc(getFirebaseDb(), "academies", academyId, "students", studentId), {
          tuitionReminderConfirmedAt: serverTimestamp(),
          tuitionReminderConfirmedByUid: uid,
        });
      }
    } catch {
      /* ignore — confirm UI closes regardless */
    } finally {
      setBusy(false);
      onConfirmAction();
    }
  };

  const suggestedAmountNum = payload.suggestedAmount ? Number(payload.suggestedAmount) : null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-4">
      <div className={`w-full max-w-sm space-y-4 ${glassOverlay}`} role="alertdialog" aria-live="assertive">
        <div>
          <p className="text-sm font-semibold text-foreground">원비 납부 안내</p>
          {payload.studentName ? (
            <p className="mt-0.5 text-xs text-neutral-500">{payload.studentName} 학생</p>
          ) : null}
        </div>

        <p className="text-sm leading-relaxed text-neutral-700">{payload.body}</p>

        {suggestedAmountNum != null && Number.isFinite(suggestedAmountNum) ? (
          <div className="rounded-2xl bg-neutral-100/80 px-4 py-3">
            <p className="text-[10px] text-neutral-500">권장 납부 금액</p>
            <p className="mt-0.5 text-base font-semibold text-foreground">
              {suggestedAmountNum.toLocaleString("ko-KR")}원
            </p>
          </div>
        ) : null}

        {payload.kakaoPayLink ? (
          <a
            href={payload.kakaoPayLink}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center w-full rounded-2xl bg-[#FEE500] py-3 text-sm font-semibold text-[#3C1E1E] hover:bg-[#F6D800] active:bg-[#EDD000]"
          >
            카카오페이로 납부하기
          </a>
        ) : null}

        {hasBankInfo ? (
          <div className="flex items-center justify-between gap-2 rounded-2xl bg-neutral-100/80 px-4 py-3">
            <div className="min-w-0">
              <p className="text-[10px] text-neutral-500">계좌번호</p>
              <p className="mt-0.5 text-sm font-medium text-foreground truncate">{accountText}</p>
            </div>
            {payload.accountNumber ? (
              <button
                type="button"
                onClick={() => void onCopy()}
                className="shrink-0 rounded-xl border border-neutral-300/70 bg-white/70 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-white"
              >
                {copied ? "복사됨" : "복사"}
              </button>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => void onConfirm()}
          disabled={busy}
          className="w-full rounded-2xl bg-[#222] dark:bg-neutral-100 py-3 text-sm font-semibold text-white dark:text-neutral-950 disabled:opacity-60"
        >
          {busy ? "확인 중…" : "확인"}
        </button>
      </div>
    </div>
  );
}

export function ParentChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [simpleOpen, setSimpleOpen] = useState(false);
  const [simpleBody, setSimpleBody] = useState("");
  const [paymentPayload, setPaymentPayload] = useState<PaymentReminderPayload | null>(null);

  useBodyScrollLock(simpleOpen);
  useParentPushLifecycleResync();

  const handleMessage = useCallback((body: string, data: Record<string, string>) => {
    if (isPaymentType(data.type ?? "")) {
      setPaymentPayload({
        body,
        studentName: data.studentName ?? "",
        studentId: data.studentId ?? "",
        academyId: data.academyId ?? "",
        suggestedAmount: data.suggestedAmount,
        kakaoPayLink: data.kakaoPayLink,
        bankName: data.bankName,
        accountNumber: data.accountNumber,
        accountHolder: data.accountHolder,
      });
    } else {
      setSimpleBody(body);
      setSimpleOpen(true);
    }
  }, []);

  useEffect(() => {
    const listen =
      pathname.startsWith("/parent") && !pathname.startsWith("/parent/session");
    if (!listen) return;
    return subscribeForegroundMessages(handleMessage);
  }, [pathname, handleMessage]);

  return (
    <>
      {children}
      {paymentPayload ? (
        <PaymentReminderModal
          payload={paymentPayload}
          onConfirmAction={() => setPaymentPayload(null)}
        />
      ) : null}
      {simpleOpen ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4">
          <div className={`w-full max-w-sm ${glassOverlay}`} role="alertdialog" aria-live="polite">
            <p className="text-sm font-medium text-foreground">알림</p>
            <p className="mt-3 text-sm text-neutral-700">{simpleBody}</p>
            <button
              type="button"
              onClick={() => setSimpleOpen(false)}
              className="mt-5 w-full rounded-2xl bg-[#222] dark:bg-neutral-100 py-2.5 text-sm font-medium text-white dark:text-neutral-950"
            >
              확인
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
