"use client";

import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useRef } from "react";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client-app";
import { isFirebaseEmulatorEnabled, isWebPushConfigured } from "@/lib/firebase/config";
import { resyncParentPushTokenAfterResume } from "@/lib/firebase/web-push";

/**
 * 프로덕션 PWA에서 흔히 쓰는 패턴: 앱이 다시 보이거나 SW가 바뀐 뒤 FCM 토큰을 다시 받아
 * 서버(Firestore 구독 문서)와 맞춥니다. 토큰 로테이션·iOS·절전 이후 불일치를 줄입니다.
 */
export function useParentPushLifecycleResync() {
  const pushEnabledRef = useRef(false);

  useEffect(() => {
    if (isFirebaseEmulatorEnabled() || !isWebPushConfigured()) return;

    const auth = getFirebaseAuth();
    let unsubDoc: (() => void) | undefined;

    const unsubAuth = auth.onAuthStateChanged((user) => {
      unsubDoc?.();
      pushEnabledRef.current = false;
      if (!user) return;
      const db = getFirebaseDb();
      unsubDoc = onSnapshot(
        doc(db, "users", user.uid),
        (snap) => {
          const en = snap.data()?.pushNotificationsEnabled === true;
          pushEnabledRef.current = en;
          if (en) {
            void resyncParentPushTokenAfterResume(() => pushEnabledRef.current);
          }
        },
        () => {
          pushEnabledRef.current = false;
        },
      );
    });

    return () => {
      unsubAuth();
      unsubDoc?.();
    };
  }, []);

  useEffect(() => {
    if (isFirebaseEmulatorEnabled() || !isWebPushConfigured()) return;

    // bfcache 복원 시에도 동일 effect 인스턴스의 리스너만 유지됨.
    // unmount 시 아래 return에서 전부 remove — 중복 등록 누적 없음.

    const run = () => {
      void resyncParentPushTokenAfterResume(() => pushEnabledRef.current);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") run();
    };

    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) run();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", run);
    window.addEventListener("pageshow", onPageShow);

    let removeControllerListener: (() => void) | undefined;
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      const handler = () => run();
      navigator.serviceWorker.addEventListener("controllerchange", handler);
      removeControllerListener = () =>
        navigator.serviceWorker.removeEventListener("controllerchange", handler);
    }

    if (document.visibilityState === "visible") run();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", run);
      window.removeEventListener("pageshow", onPageShow);
      removeControllerListener?.();
    };
  }, []);
}
