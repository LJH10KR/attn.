"use client";

import { getApp } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import {
  deleteToken,
  getMessaging,
  getToken,
  isSupported,
  onMessage,
  type Messaging,
} from "firebase/messaging";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { getFirebaseWebVapidKey, isFirebaseEmulatorEnabled, isWebPushConfigured } from "@/lib/firebase/config";

export type WebPushPrepareResult =
  | { ok: true; messaging: Messaging }
  | { ok: false; reason: "emulator" | "unsupported" | "no_vapid" | "no_sw" | "no_token" | "unknown"; message?: string };

export async function prepareWebPushMessaging(): Promise<WebPushPrepareResult> {
  if (typeof window === "undefined") {
    return { ok: false, reason: "unknown", message: "브라우저에서만 사용할 수 있습니다." };
  }
  if (isFirebaseEmulatorEnabled()) {
    return { ok: false, reason: "emulator", message: "에뮬레이터 환경에서는 웹 푸시를 사용할 수 없습니다." };
  }
  if (!isWebPushConfigured()) {
    return {
      ok: false,
      reason: "no_vapid",
      message: "푸시 설정(VAPID)이 없습니다. 관리자에게 문의해 주세요.",
    };
  }
  if (!(await isSupported())) {
    return { ok: false, reason: "unsupported", message: "이 브라우저에서는 웹 푸시를 지원하지 않습니다." };
  }
  try {
    getFirebaseAuth();
    const messaging = getMessaging(getApp());
    return { ok: true, messaging };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Firebase Messaging을 초기화하지 못했습니다.";
    return { ok: false, reason: "unknown", message };
  }
}

export async function registerMessagingServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    /** 첫 방문 시 installing → activating 사이에 getToken 하면 "no active Service Worker" 발생 */
    await navigator.serviceWorker.register("/firebase-messaging-sw.js", { scope: "/" });
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

export async function fetchFcmToken(): Promise<{ token: string | null; error?: string }> {
  const prep = await prepareWebPushMessaging();
  if (!prep.ok) {
    return { token: null, error: prep.message ?? "푸시를 준비할 수 없습니다." };
  }
  const reg = await registerMessagingServiceWorker();
  if (!reg) {
    return { token: null, error: "서비스 워커를 등록하지 못했습니다." };
  }
  const vapidKey = getFirebaseWebVapidKey();
  try {
    const token = await getToken(prep.messaging, { vapidKey, serviceWorkerRegistration: reg });
    if (!token) {
      return { token: null, error: "FCM 토큰을 받지 못했습니다." };
    }
    return { token };
  } catch (e) {
    const message = e instanceof Error ? e.message : "FCM 토큰 요청에 실패했습니다.";
    return { token: null, error: message };
  }
}

export async function removeFcmTokenLocal(): Promise<void> {
  const prep = await prepareWebPushMessaging();
  if (!prep.ok) return;
  try {
    await deleteToken(prep.messaging);
  } catch {
    /* ignore */
  }
}

export async function callSyncParentPushSubscription(enabled: boolean, fcmToken?: string): Promise<void> {
  const fn = httpsCallable(getFirebaseFunctions(), "syncParentPushSubscription");
  await fn(
    enabled
      ? { enabled: true, fcmToken: fcmToken ?? "" }
      : { enabled: false },
  );
}

export function subscribeForegroundMessages(
  onPayload: (body: string) => void,
): () => void {
  let cancelled = false;
  let unsub: (() => void) | undefined;
  void (async () => {
    const prep = await prepareWebPushMessaging();
    if (!prep.ok || cancelled) return;
    unsub = onMessage(prep.messaging, (payload) => {
      const d = payload.data;
      if (!d || d.type !== "attendance") return;
      const body = typeof d.body === "string" ? d.body : "";
      if (body) onPayload(body);
    });
  })();
  return () => {
    cancelled = true;
    unsub?.();
  };
}
