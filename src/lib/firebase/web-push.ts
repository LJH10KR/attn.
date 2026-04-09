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

/** 마지막으로 서버에 동기화한 FCM 토큰 — 변경 시에만 `syncParentPushSubscription` 호출 */
export const FCM_LAST_SYNCED_TOKEN_STORAGE_KEY = "attn_fcm_last_synced_token";

export function clearLastSyncedFcmTokenStorage(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(FCM_LAST_SYNCED_TOKEN_STORAGE_KEY);
  } catch {
    /* 사생활 보호 모드 등 */
  }
}

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

/**
 * 푸시가 켜진 상태에서만: FCM 토큰을 받아 서버(`pushSubscriptions`)에 맞춥니다.
 *
 * 예전에는 sessionStorage의 마지막 토큰과 같으면 Callable을 건너뛰었는데, 서버가 무효 토큰 문서만
 * 삭제한 뒤에는 클라이언트 토큰 문자열이 그대로여도 Firestore 구독이 비어 있을 수 있습니다.
 * 그때 재업로드를 생략하면 “설정은 켜짐인데 푸시가 안 옴”이 됩니다. 문자열이 같아도 동기화합니다.
 */
export async function resyncParentPushTokenAfterResume(
  isPushEnabled: () => boolean,
): Promise<void> {
  if (typeof window === "undefined") return;
  if (!isPushEnabled()) return;

  const { token, error } = await fetchFcmToken();
  if (!token || error) return;

  try {
    await callSyncParentPushSubscription(true, token);
    try {
      sessionStorage.setItem(FCM_LAST_SYNCED_TOKEN_STORAGE_KEY, token);
    } catch {
      /* ignore */
    }
  } catch {
    /* 다음 복귀 시 재시도 */
  }
}

export function subscribeForegroundMessages(
  onPayload: (body: string) => void,
): () => void {
  let cancelled = false;
  let unsub: (() => void) | undefined;
  void (async () => {
    const prep = await prepareWebPushMessaging();
    if (!prep.ok || cancelled) return;
    const reg = await registerMessagingServiceWorker();
    if (!reg || cancelled) return;
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
