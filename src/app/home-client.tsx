"use client";

import { onAuthStateChanged } from "firebase/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getFirebaseAuth } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { redirectIfKnownSessionDashboard } from "@/lib/firebase/resolve-session-dashboard";
import { getLastDashboardRoleHintPath } from "@/lib/auth/last-dashboard-role";

type Phase = "checking" | "ready";

export function HomeClient() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(() => (isFirebaseConfigured() ? "checking" : "ready"));

  useEffect(() => {
    if (!isFirebaseConfigured()) {
      setPhase("ready");
      return;
    }

    // 인증 복원을 기다리는 동안 마지막 로그인 역할의 대시보드 라우트를 미리 받아둔다.
    // 실제 진입 가능 여부는 각 대시보드 페이지가 항상 스스로 재확인하므로 안전하다.
    const hintedPath = getLastDashboardRoleHintPath();
    if (hintedPath) {
      router.prefetch(hintedPath);
    }

    let cancelled = false;
    const auth = getFirebaseAuth();

    const unsub = onAuthStateChanged(auth, async (user) => {
      if (cancelled) return;
      if (!user) {
        setPhase("ready");
        return;
      }
      try {
        const result = await redirectIfKnownSessionDashboard(user, (path) => {
          if (!cancelled) router.replace(path);
        });
        if (!cancelled && result === "stay") {
          setPhase("ready");
        }
      } catch {
        if (!cancelled) setPhase("ready");
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [router]);

  if (phase === "checking") {
    return (
      <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center gap-6 px-6">
        <p className="text-sm text-neutral-500">불러오는 중…</p>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center gap-6 px-6">
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">attn.</h1>
      <p className="max-w-sm text-center text-sm text-neutral-600 dark:text-neutral-400">
        학부모를 위한 출석·결석 알림 서비스
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/login"
          className="rounded-2xl bg-[#222] px-8 py-3.5 text-sm font-medium text-white dark:text-neutral-950 shadow-lg transition hover:bg-[#333] dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-white"
        >
          로그인
        </Link>
        <Link
          href="/signup"
          className="rounded-2xl border border-neutral-400/50 bg-white/60 px-8 py-3.5 text-sm font-medium text-foreground shadow-sm backdrop-blur-md transition hover:bg-white/90 dark:border-white/15 dark:bg-white/10 dark:hover:bg-white/15"
        >
          오너 회원가입
        </Link>
      </div>
    </div>
  );
}
