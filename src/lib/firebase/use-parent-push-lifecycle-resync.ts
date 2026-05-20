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
  /** `onSnapshot`은 `updatedAt` 등 어떤 필드 변경에도 호출됨 — 매번 resync하면 Callable이 user 루트를 갱신해 무한 루프가 됨 */
  const prevPushNotificationsEnabledRef = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    if (isFirebaseEmulatorEnabled() || !isWebPushConfigured()) return;

    const auth = getFirebaseAuth();
    let unsubDoc: (() => void) | undefined;

    const unsubAuth = auth.onAuthStateChanged((user) => {
      unsubDoc?.();
      pushEnabledRef.current = false;
      prevPushNotificationsEnabledRef.current = undefined;
      if (!user) return;
      const db = getFirebaseDb();
      unsubDoc = onSnapshot(
        doc(db, "users", user.uid),
        (snap) => {
          const en = snap.data()?.pushNotificationsEnabled === true;
          const prev = prevPushNotificationsEnabledRef.current;
          prevPushNotificationsEnabledRef.current = en;
          pushEnabledRef.current = en;
          // 푸시가 꺼짐→켜짐으로 바뀔 때, 또는 첫 로드에서 이미 켜져 있을 때 한 번만 동기화
          if (en && prev !== true) {
            void resyncParentPushTokenAfterResume(() => pushEnabledRef.current, { force: true });
          }
        },
        () => {
          pushEnabledRef.current = false;
          prevPushNotificationsEnabledRef.current = undefined;
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

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", run);
      window.removeEventListener("pageshow", onPageShow);
      removeControllerListener?.();
    };
  }, []);
}
