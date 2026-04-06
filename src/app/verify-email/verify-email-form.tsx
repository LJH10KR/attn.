"use client";

import { FirebaseError } from "firebase/app";
import { onAuthStateChanged, sendEmailVerification, type User } from "firebase/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { getFirebaseAuth } from "@/lib/firebase/client-app";
import { upsertOwnerProfile } from "@/lib/firebase/owner-profile";

const RESEND_COOLDOWN_SEC = 60;

function verifyErrorMessage(code: string): string {
  switch (code) {
    case "auth/too-many-requests":
      return "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
    default:
      return "메일을 보내지 못했습니다. 다시 시도해 주세요.";
  }
}

export function VerifyEmailForm() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const configured = isFirebaseConfigured();

  useEffect(() => {
    if (!configured) {
      return;
    }
    const auth = getFirebaseAuth();
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
    });
    return () => unsub();
  }, [configured]);

  useEffect(() => {
    if (cooldown <= 0) {
      return;
    }
    const t = window.setInterval(() => {
      setCooldown((c) => Math.max(0, c - 1));
    }, 1000);
    return () => window.clearInterval(t);
  }, [cooldown]);

  const onResend = useCallback(async () => {
    setError(null);
    setInfo(null);
    if (!configured || !user) {
      return;
    }
    if (cooldown > 0) {
      return;
    }
    setBusy(true);
    try {
      const continueUrl =
        typeof window !== "undefined"
          ? `${window.location.origin}/verify-email`
          : undefined;
      await sendEmailVerification(user, continueUrl ? { url: continueUrl } : undefined);
      setInfo("인증 메일을 다시 보냈습니다.");
      setCooldown(RESEND_COOLDOWN_SEC);
    } catch (err) {
      const code = err instanceof FirebaseError ? err.code : "";
      setError(verifyErrorMessage(code));
    } finally {
      setBusy(false);
    }
  }, [configured, cooldown, user]);

  const onConfirmVerified = useCallback(async () => {
    setError(null);
    setInfo(null);
    if (!configured || !user) {
      return;
    }
    setBusy(true);
    try {
      await user.reload();
      const auth = getFirebaseAuth();
      const fresh = auth.currentUser;
      if (!fresh?.emailVerified) {
        setError("아직 이메일 인증이 완료되지 않았습니다. 메일의 링크를 눌러 주세요.");
        return;
      }
      await upsertOwnerProfile(fresh);
      router.replace("/owner");
    } catch (err) {
      const code = err instanceof FirebaseError ? err.code : "";
      setError(code ? verifyErrorMessage(code) : "확인에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }, [configured, router, user]);

  if (!configured) {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center px-4">
        <p className="text-center text-sm text-neutral-600">
          Firebase 설정이 필요합니다.
        </p>
      </div>
    );
  }

  if (user === null) {
    return (
      <div className="min-h-[100dvh] bg-background px-4 py-16 flex flex-col items-center justify-center">
        <div className="glass-card-soft w-full max-w-md p-8 text-center">
          <p className="text-sm text-neutral-700 dark:text-neutral-300">로그인된 세션이 없습니다.</p>
          <Link
            href="/login"
            className="mt-6 inline-block rounded-2xl bg-[#222] dark:bg-neutral-100 px-6 py-3 text-sm font-medium text-white dark:text-neutral-950"
          >
            로그인
          </Link>
        </div>
      </div>
    );
  }

  if (user.emailVerified) {
    return (
      <div className="min-h-[100dvh] bg-background px-4 py-16 flex flex-col items-center justify-center">
        <div className="glass-card-soft w-full max-w-md p-8 text-center">
          <p className="text-sm text-neutral-700 dark:text-neutral-300">이미 인증이 완료된 계정입니다.</p>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await upsertOwnerProfile(user);
                router.replace("/owner");
              } finally {
                setBusy(false);
              }
            }}
            className="mt-6 w-full rounded-2xl bg-[#222] dark:bg-neutral-100 py-3 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-50"
          >
            {busy ? "처리 중…" : "시작하기"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background px-4 py-10 flex flex-col items-center justify-center pb-[max(2rem,env(safe-area-inset-bottom))]">
      <div className="glass-card-hero w-full max-w-[400px] p-8">
        <h1 className="text-center text-xl font-semibold text-foreground">이메일 인증</h1>
        <p className="mt-3 text-center text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          아래 주소로 인증 메일을 보냈습니다. 메일의 링크를 눌러 인증을 완료한 뒤{" "}
          <span className="font-medium text-foreground">「인증 완료 확인」</span>을 눌러 주세요.
        </p>
        <p className="mt-4 rounded-2xl bg-white/50 px-3 py-2 text-center text-sm font-medium text-foreground ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10">
          {user.email}
        </p>

        {error ? (
          <p
            className="mt-4 rounded-2xl bg-red-500/10 px-3 py-2.5 text-center text-sm text-red-800 ring-1 ring-red-500/15"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        {info ? (
          <p className="mt-4 rounded-2xl bg-emerald-500/10 px-3 py-2.5 text-center text-sm text-emerald-900 ring-1 ring-emerald-500/15">
            {info}
          </p>
        ) : null}

        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            disabled={busy || cooldown > 0}
            onClick={onConfirmVerified}
            className="w-full rounded-2xl bg-[#222] dark:bg-neutral-100 py-3.5 text-[15px] font-medium text-white dark:text-neutral-950 shadow-lg transition hover:bg-[#333] dark:hover:bg-white disabled:opacity-50"
          >
            {busy ? "처리 중…" : "인증 완료 확인"}
          </button>
          <button
            type="button"
            disabled={busy || cooldown > 0}
            onClick={onResend}
            className="w-full rounded-2xl border border-neutral-300/70 bg-white/50 py-3.5 text-[15px] font-medium text-foreground backdrop-blur-md transition hover:bg-white/80 disabled:opacity-50"
          >
            {cooldown > 0
              ? `인증 메일 다시 보내기 (${cooldown}초)`
              : "인증 메일 다시 보내기"}
          </button>
        </div>

        <p className="mt-6 text-center text-sm text-neutral-600">
          <Link href="/login" className="font-medium text-[#4a90e2] underline-offset-2 hover:underline">
            로그인으로
          </Link>
        </p>
      </div>
    </div>
  );
}
