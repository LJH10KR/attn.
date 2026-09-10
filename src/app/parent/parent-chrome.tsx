"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useParentPushLifecycleResync } from "@/lib/firebase/use-parent-push-lifecycle-resync";
import { subscribeForegroundMessages } from "@/lib/firebase/web-push";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";
import {
  PaymentReminderModal,
  type PaymentReminderPayload,
} from "@/components/parent/payment-reminder-modal";

const glassOverlay =
  "rounded-[1.75rem] border border-white/70 bg-[rgba(252,251,248,0.98)] p-6 shadow-[0_24px_80px_-20px_rgba(0,0,0,0.2)]";

function isPaymentType(type: string): boolean {
  return type === "tuition_reminder" || type === "session_payment_reminder";
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
