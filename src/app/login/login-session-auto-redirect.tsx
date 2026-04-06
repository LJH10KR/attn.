"use client";

import { onAuthStateChanged } from "firebase/auth";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { getFirebaseAuth } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import {
  redirectIfKnownSessionDashboard,
  shouldSkipLoginSessionAutoRedirect,
} from "@/lib/firebase/resolve-session-dashboard";

/**
 * PWA가 마지막 URL로 `/login`만 복원하는 경우, 세션이 있으면 역할에 맞는 화면으로 보냅니다.
 * `?stay=1` · `?role=` · `?msg=` 가 있으면 로그인 UI를 유지합니다.
 */
export function LoginSessionAutoRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const attemptedRef = useRef(false);
  const queryKey = searchParams.toString();

  useEffect(() => {
    attemptedRef.current = false;
    if (!isFirebaseConfigured()) return;
    if (shouldSkipLoginSessionAutoRedirect(new URLSearchParams(queryKey))) return;

    let cancelled = false;
    const auth = getFirebaseAuth();

    const unsub = onAuthStateChanged(auth, async (user) => {
      if (cancelled || !user || attemptedRef.current) return;
      attemptedRef.current = true;
      try {
        const result = await redirectIfKnownSessionDashboard(user, (path) => {
          if (!cancelled) router.replace(path);
        });
        if (!cancelled && result === "stay") {
          attemptedRef.current = false;
        }
      } catch {
        if (!cancelled) {
          attemptedRef.current = false;
        }
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [router, queryKey]);

  return null;
}
