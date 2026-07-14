"use client";

import { getApp } from "firebase/app";
import { doc, getDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import {
  deleteToken,
  getMessaging,
  getToken,
  isSupported,
  onMessage,
  type Messaging,
} from "firebase/messaging";
import { getFirebaseAuth, getFirebaseDb, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { getFirebaseWebVapidKey, isFirebaseEmulatorEnabled, isWebPushConfigured } from "@/lib/firebase/config";
import { setAppIconBadgeFromPushData } from "@/lib/ios/app-badge";

/** 마지막으로 서버에 동기화한 FCM 토큰 — 로그아웃·계정 전환 시 제거 */
export const FCM_LAST_SYNCED_TOKEN_STORAGE_KEY = "attn_fcm_last_synced_token";

/** focus/visibility 등이 연속으로 올 때 Callable 폭주 방지 (포그라운드마다 동기화는 유지) */
const RESYNC_MIN_INTERVAL_MS = 5_000;
const RESYNC_MAX_ATTEMPTS = 3;

let resyncInFlight: Promise<void> | null = null;
let lastResyncFinishedAt = 0;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type FetchFcmTokenOptions = {
  /**
   * iOS PWA 재실행 직후 등: 기존 등록을 지우고 FCM에 새 구독을 요청합니다.
   * 문자열이 같아도 FCM 쪽 `registration-token-not-registered`를 줄이는 데 도움이 됩니다.
   */
  rotateToken?: boolean;
};

export async function fetchFcmToken(
  options?: FetchFcmTokenOptions,
): Promise<{ token: string | null; error?: string }> {
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
    if (options?.rotateToken === true) {
      try {
        await deleteToken(prep.messaging);
      } catch {
        /* 이미 없거나 만료 — 새 getToken 시도는 계속 */
      }
      await sleep(400);
    }
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

export type ParentPushSyncMeta = {
  clientAtMillis?: number;
  syncMode?: "normal" | "force_rotate";
};

export async function callSyncParentPushSubscription(
  enabled: boolean,
  fcmToken?: string,
  meta?: ParentPushSyncMeta,
): Promise<void> {
  const fn = httpsCallable(getFirebaseFunctions(), "syncParentPushSubscription");
  await fn(
    enabled
      ? {
          enabled: true,
          fcmToken: fcmToken ?? "",
          clientAtMillis: meta?.clientAtMillis,
          syncMode: meta?.syncMode ?? "normal",
        }
      : { enabled: false },
  );
}

/**
 * 학부모 로그아웃 직전에 호출합니다 (`signOut` 전에, 인증이 유효할 때).
 * - 서버: `syncParentPushSubscription(false)` → `users/{uid}/pushSubscriptions` 정리 및 `pushNotificationsEnabled: false`
 * - 클라: FCM `deleteToken`(가능할 때), 마지막 동기화용 sessionStorage 제거
 *
 * 동일 브라우저에서 다른 학부모 계정으로 바꿀 때 이전 사용자 토큰이 섞이지 않도록 합니다.
 */
export async function tearDownParentWebPushForLogout(): Promise<void> {
  if (isFirebaseEmulatorEnabled()) {
    clearLastSyncedFcmTokenStorage();
    return;
  }

  try {
    await callSyncParentPushSubscription(false);
  } catch {
    /* 오프라인 등 — 로컬 정리는 계속 */
  }

  if (isWebPushConfigured()) {
    try {
      await removeFcmTokenLocal();
    } catch {
      /* ignore */
    }
  }
  clearLastSyncedFcmTokenStorage();
}

export type ParentPushResyncOptions = {
  parentUid: string;
  /** ref 등 빠른 경로; true면 Firestore 재확인을 생략하고 바로 동기화합니다 */
  enabled?: boolean;
  force?: boolean;
};

async function resolveParentPushEnabled(
  parentUid: string,
  enabled?: boolean,
): Promise<boolean> {
  try {
    if (enabled === true) return true;
    const snap = await getDoc(doc(getFirebaseDb(), "users", parentUid));
    return snap.data()?.pushNotificationsEnabled === true;
  } catch {
    return false;
  }
}

/**
 * 푸시 ON 상태에서 FCM 토큰을 받아 서버(`pushSubscriptions`)와 맞춥니다.
 * 토큰 문자열이 같아도 서버에 매번 올려 무효 토큰 삭제·iOS 절전 이후 공백을 복구합니다.
 */
async function resyncParentPushTokenAfterResumeInner(options: ParentPushResyncOptions): Promise<void> {
  if (typeof window === "undefined") return;

  const { parentUid, enabled, force = false } = options;
  if (!parentUid) return;

  const enabledVerified = await resolveParentPushEnabled(parentUid, enabled);
  if (!enabledVerified) return;

  const now = Date.now();
  if (!force && now - lastResyncFinishedAt < RESYNC_MIN_INTERVAL_MS) {
    return;
  }

  const { token, error } = await fetchFcmToken({ rotateToken: force });
  if (!token || error) return;

  for (let attempt = 0; attempt < RESYNC_MAX_ATTEMPTS; attempt++) {
    try {
      await callSyncParentPushSubscription(true, token, {
        clientAtMillis: Date.now(),
        syncMode: force ? "force_rotate" : "normal",
      });
      try {
        sessionStorage.setItem(FCM_LAST_SYNCED_TOKEN_STORAGE_KEY, token);
      } catch {
        /* ignore */
      }
      lastResyncFinishedAt = Date.now();
      return;
    } catch {
      if (attempt < RESYNC_MAX_ATTEMPTS - 1) {
        await sleep(1000 * (attempt + 1));
      }
    }
  }
}

/**
 * 앱 재실행·탭 복귀·SW 갱신 시 FCM 토큰을 서버와 조용히 맞춥니다 (iOS/Android PWA 공통).
 */
export async function resyncParentPushTokenAfterResume(options: ParentPushResyncOptions): Promise<void> {
  if (resyncInFlight) {
    await resyncInFlight;
    return;
  }
  resyncInFlight = resyncParentPushTokenAfterResumeInner(options).finally(() => {
    resyncInFlight = null;
  });
  await resyncInFlight;
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
      if (!d) return;
      setAppIconBadgeFromPushData(d);
      if (d.type !== "attendance" && d.type !== "tuition_reminder" && d.type !== "session_payment_reminder") return;
      const body = typeof d.body === "string" ? d.body : "";
      if (body) onPayload(body);
    });
  })();
  return () => {
    cancelled = true;
    unsub?.();
  };
}
