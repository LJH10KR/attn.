"use client";

import { onAuthStateChanged } from "firebase/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getFirebaseAuth } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { redirectIfKnownSessionDashboard } from "@/lib/firebase/resolve-session-dashboard";
import { getLastDashboardRoleHintPath } from "@/lib/auth/last-dashboard-role";
import {
  BOOT_PROGRESS,
  hasShownBootOverlayThisSession,
  markBootOverlayShown,
  useBootOverlay,
} from "@/components/boot/boot-overlay";

type Phase = "checking" | "ready";

export function HomeClient() {
  const router = useRouter();
  const { show: showBootOverlay, hide: hideBootOverlay, setProgress } = useBootOverlay();
  const [phase, setPhase] = useState<Phase>(() => (isFirebaseConfigured() ? "checking" : "ready"));

  useEffect(() => {
    if (!isFirebaseConfigured()) {
      setPhase("ready");
      return;
    }

    // 이번 세션(탭)에서 처음 여는 경우에만 부팅 애니메이션을 보여준다 — 앱 안에서
    // "홈" 등으로 "/"를 다시 거치는 재방문(설정 화면 → 홈 등)에는 재생하지 않는다.
    if (!hasShownBootOverlayThisSession()) {
      showBootOverlay();
      markBootOverlayShown();
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
        hideBootOverlay();
        setPhase("ready");
        return;
      }
      setProgress(BOOT_PROGRESS.AUTH_RESTORED);
      try {
        const result = await redirectIfKnownSessionDashboard(user, (path) => {
          if (!cancelled) router.replace(path);
        });
        // "redirected"면 오버레이는 그대로 유지 — 대상 대시보드 페이지가 자기 로딩이
        // 끝나는 시점에 hideBootOverlay()를 호출해 끊김 없이 이어진다.
        if (!cancelled && result === "redirected") {
          setProgress(BOOT_PROGRESS.ROLE_RESOLVED);
        }
        if (!cancelled && result === "stay") {
          hideBootOverlay();
          setPhase("ready");
        }
      } catch {
        if (!cancelled) {
          hideBootOverlay({ immediate: true });
          setPhase("ready");
        }
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [router, showBootOverlay, hideBootOverlay, setProgress]);

  if (phase === "checking") {
    return null;
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
