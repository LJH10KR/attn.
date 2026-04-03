"use client";

import { type FirebaseApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
import { isFirebaseEmulatorEnabled } from "./config";

let initialized = false;

/**
 * App Check — 봇·스크립트의 Callable 남용을 줄여 Functions/Firestore 비용·쿼터 압박을 완화.
 * `NEXT_PUBLIC_APPCHECK_SITE_KEY`가 없으면 아무 것도 하지 않음.
 * 에뮬레이터: 콘솔에 출력되는 디버그 토큰을 콘솔에 등록하거나 `NEXT_PUBLIC_APPCHECK_DEBUG_TOKEN` 사용.
 */
export function initFirebaseAppCheck(app: FirebaseApp): void {
  if (typeof window === "undefined" || initialized) {
    return;
  }
  const siteKey = process.env.NEXT_PUBLIC_APPCHECK_SITE_KEY?.trim();
  if (!siteKey) {
    return;
  }

  if (isFirebaseEmulatorEnabled()) {
    const dbg = process.env.NEXT_PUBLIC_APPCHECK_DEBUG_TOKEN?.trim();
    const g = globalThis as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string };
    g.FIREBASE_APPCHECK_DEBUG_TOKEN = dbg && dbg.length > 0 ? dbg : true;
  }

  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(siteKey),
    isTokenAutoRefreshEnabled: true,
  });
  initialized = true;
}
