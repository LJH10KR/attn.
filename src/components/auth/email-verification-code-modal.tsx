"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useRef, useState } from "react";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

/** 원장 가입 이메일 인증만(2-L — 학부모는 휴대폰 번호 확인) */
export type EmailVerificationPurpose = "owner";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3.5 text-center font-mono text-lg tracking-[0.35em] text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

/**
 * 발송 상태(3-A 후속 F1) — 창이 열리면 자동으로 한 번 보낸다(`mode: "auto"`).
 * - sending: 보내는 중 / sent: 자동 발송 성공 / resent: [다시 받기] 성공
 * - recent: 최근 보낸 유효 코드가 있어 새로 만들지 않음 / cooldown: 60초 안에 보낸 코드가 있음
 * - failed: 보내지 못함
 */
type SendState = "sending" | "sent" | "resent" | "recent" | "cooldown" | "failed";

type IssueResponse = {
  alreadyVerified?: boolean;
  sent?: boolean;
  reason?: "recent" | "cooldown";
};

function statusMessage(state: SendState, emailHint?: string | null): string {
  const to = emailHint ? `${emailHint}(으)로 ` : "이메일로 ";
  switch (state) {
    case "sending":
      return `${to}인증 코드를 보내는 중이에요…`;
    case "sent":
      return `${to}6자리 인증 코드를 보냈어요. 메일함(스팸함 포함)을 확인해 주세요.`;
    case "resent":
      return `${to}인증 코드를 다시 보냈어요. 가장 최근에 받은 코드를 입력해 주세요.`;
    case "recent":
      return `${to}최근 보낸 6자리 인증 코드를 입력해 주세요.`;
    case "cooldown":
      return "방금 보낸 인증 코드를 입력해 주세요. 1분 뒤 다시 받을 수 있어요.";
    case "failed":
      return "인증 코드를 보내지 못했어요. [인증 코드 다시 받기]를 눌러 주세요.";
  }
}

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
  const [sendState, setSendState] = useState<SendState>("sending");

  /** 창이 열릴 때마다 늘어나는 번호 — 닫힌 뒤 도착한 늦은 응답은 버린다 */
  const openSeqRef = useRef(0);
  /** 이번 열림에 자동 발송을 했는지 — 개발 모드 effect 이중 실행에도 한 번만(닫힐 때만 초기화) */
  const autoIssuedRef = useRef(false);
  const onVerifiedRef = useRef(onVerifiedAction);
  useEffect(() => {
    onVerifiedRef.current = onVerifiedAction;
  }, [onVerifiedAction]);

  useEffect(() => {
    if (!open) {
      openSeqRef.current += 1;
      autoIssuedRef.current = false;
      setCode("");
      setError(null);
      setSendState("sending");
      setResendBusy(false);
      return;
    }
    if (autoIssuedRef.current) return;
    autoIssuedRef.current = true;
    const seq = openSeqRef.current;
    setSendState("sending");
    void (async () => {
      try {
        const fn = httpsCallable<{ purpose: string; mode: "auto" }, IssueResponse>(
          getFirebaseFunctions(),
          "issueEmailVerificationOtp",
        );
        const { data } = await fn({ purpose, mode: "auto" });
        if (seq !== openSeqRef.current) return;
        if (data?.alreadyVerified) {
          await onVerifiedRef.current();
          return;
        }
        if (data?.sent) setSendState("sent");
        else setSendState(data?.reason === "cooldown" ? "cooldown" : "recent");
      } catch (e) {
        if (seq !== openSeqRef.current) return;
        if (e instanceof FirebaseError && e.code === "functions/resource-exhausted") {
          setSendState("cooldown");
          return;
        }
        setSendState("failed");
        setError(e instanceof FirebaseError ? e.message : null);
      }
    })();
  }, [open, purpose]);

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
    const seq = openSeqRef.current;
    setError(null);
    setResendBusy(true);
    setSendState("sending");
    try {
      const fn = httpsCallable<{ purpose: string; mode: "resend" }, IssueResponse>(
        getFirebaseFunctions(),
        "issueEmailVerificationOtp",
      );
      const { data } = await fn({ purpose, mode: "resend" });
      if (seq !== openSeqRef.current) return;
      if (data?.alreadyVerified) {
        await onVerifiedAction();
        return;
      }
      setSendState("resent");
    } catch (e) {
      if (seq !== openSeqRef.current) return;
      if (e instanceof FirebaseError && e.code === "functions/resource-exhausted") {
        setSendState("cooldown");
        return;
      }
      setSendState("failed");
      setError(e instanceof FirebaseError ? e.message : null);
    } finally {
      if (seq === openSeqRef.current) setResendBusy(false);
    }
  }, [onVerifiedAction, purpose]);

  if (!open) return null;

  const statusTone =
    sendState === "failed"
      ? "text-red-700"
      : sendState === "sent" || sendState === "resent"
        ? "text-emerald-800 dark:text-emerald-400"
        : "text-neutral-600 dark:text-neutral-400";

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="이메일 인증 코드 입력"
    >
      <div className="w-full max-w-sm rounded-3xl bg-white px-6 py-7 shadow-xl dark:bg-neutral-900">
        <h2 className="text-center text-base font-semibold text-foreground">이메일 인증</h2>
        <p
          className={`mt-3 break-keep text-center text-sm leading-relaxed ${statusTone}`}
          role="status"
          aria-live="polite"
          data-send-state={sendState}
        >
          {statusMessage(sendState, emailHint)}
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
          disabled={resendBusy || busy || sendState === "sending"}
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
