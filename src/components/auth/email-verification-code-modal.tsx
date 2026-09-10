"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useState } from "react";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

export type EmailVerificationPurpose = "owner" | "parent";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3.5 text-center font-mono text-lg tracking-[0.35em] text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

export function EmailVerificationCodeModal({
  open,
  purpose,
  emailHint,
  onVerifiedAction,
  onCloseAction,
}: {
  open: boolean;
  purpose: EmailVerificationPurpose;
  emailHint?: string | null;
  onVerifiedAction: () => void | Promise<void>;
  onCloseAction?: () => void;
}) {
  useBodyScrollLock(open);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    if (!open) {
      setCode("");
      setError(null);
      setResent(false);
    }
  }, [open]);

  const onVerify = useCallback(async () => {
    setError(null);
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      setError("6자리 인증 코드를 입력해 주세요.");
      return;
    }
    setBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "verifyEmailVerificationOtp");
      await fn({ code: trimmed, purpose });
      await onVerifiedAction();
    } catch (e) {
      setError(e instanceof FirebaseError ? e.message : "인증에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }, [code, onVerifiedAction, purpose]);

  const onResend = useCallback(async () => {
    setError(null);
    setResent(false);
    setResendBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "issueEmailVerificationOtp");
      await fn({ purpose });
      setResent(true);
    } catch (e) {
      setError(e instanceof FirebaseError ? e.message : "재발송에 실패했습니다.");
    } finally {
      setResendBusy(false);
    }
  }, [purpose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="이메일 인증 코드 입력"
    >
      <div className="w-full max-w-sm rounded-3xl bg-white px-6 py-7 shadow-xl dark:bg-neutral-900">
        <h2 className="text-center text-base font-semibold text-foreground">이메일 인증</h2>
        <p className="mt-3 text-center text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          {emailHint
            ? `${emailHint}(으)로 발송된 6자리 인증 코드를 입력해 주세요.`
            : "이메일로 발송된 6자리 인증 코드를 입력해 주세요."}
        </p>
        <input
          id="email-verify-code"
          className={`${inputClass} mt-5`}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          disabled={busy}
          aria-label="6자리 인증 코드"
        />
        {error ? <p className="mt-3 text-center text-sm text-red-700">{error}</p> : null}
        {resent ? (
          <p className="mt-3 text-center text-sm text-emerald-800">인증 코드를 다시 발송했습니다.</p>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void onVerify()}
          className="mt-5 w-full rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-950"
        >
          {busy ? "확인 중…" : "인증 완료"}
        </button>
        <button
          type="button"
          disabled={resendBusy || busy}
          onClick={() => void onResend()}
          className="mt-3 w-full text-sm text-[#4a90e2] underline disabled:opacity-50"
        >
          {resendBusy ? "발송 중…" : "인증 코드 다시 받기"}
        </button>
        {onCloseAction ? (
          <button
            type="button"
            disabled={busy}
            onClick={onCloseAction}
            className="mt-4 w-full text-sm text-neutral-500"
          >
            닫기
          </button>
        ) : null}
      </div>
    </div>
  );
}
