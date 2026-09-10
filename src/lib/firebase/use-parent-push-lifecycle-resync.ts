"use client";

import { doc, onSnapshot } from "firebase/firestore";
import { useCallback, useEffect, useRef } from "react";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client-app";
import { isFirebaseEmulatorEnabled, isWebPushConfigured } from "@/lib/firebase/config";
import { resyncParentPushTokenAfterResume } from "@/lib/firebase/web-push";

/**
 * PWA 포그라운드·SW 갱신 시 FCM 토큰을 서버와 조용히 맞춥니다 (iOS/Android 공통).
 * `pushNotificationsEnabled`가 켜져 있으면 사용자 추가 조작 없이 구독을 유지·복구합니다.
 */
export function useParentPushLifecycleResync() {
  const parentUidRef = useRef<string | null>(null);
  const pushEnabledRef = useRef(false);
  /** onSnapshot이 `updatedAt` 등으로 다시 불릴 때 resync 루프 방지 */
  const prevPushNotificationsEnabledRef = useRef<boolean | undefined>(undefined);

  const triggerResync = useCallback((opts?: { force?: boolean }) => {
    const uid = parentUidRef.current;
    if (!uid) return;
    void resyncParentPushTokenAfterResume({
      parentUid: uid,
      enabled: pushEnabledRef.current,
      force: opts?.force,
    });
  }, []);

  useEffect(() => {
    if (isFirebaseEmulatorEnabled() || !isWebPushConfigured()) return;

    const auth = getFirebaseAuth();
    let unsubDoc: (() => void) | undefined;

    const unsubAuth = auth.onAuthStateChanged((user) => {
      unsubDoc?.();
      parentUidRef.current = user?.uid ?? null;
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
          if (en && prev !== true) {
            triggerResync({ force: true });
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
  }, [triggerResync]);

  useEffect(() => {
    if (isFirebaseEmulatorEnabled() || !isWebPushConfigured()) return;

    const auth = getFirebaseAuth();
    const uid = auth.currentUser?.uid;
    if (uid) {
      parentUidRef.current = uid;
      triggerResync({ force: true });
    }

    const run = () => triggerResync();

    const onVisibility = () => {
      if (document.visibilityState === "visible") run();
    };

    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) triggerResync({ force: true });
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", run);
    window.addEventListener("pageshow", onPageShow);

    let removeControllerListener: (() => void) | undefined;
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      const handler = () => triggerResync({ force: true });
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
  }, [triggerResync]);
}
