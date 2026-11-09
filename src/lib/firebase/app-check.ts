"use client";

import { httpsCallable, type HttpsCallable } from "firebase/functions";
import { getToken, initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from "firebase/app-check";
import { getFirebaseApp, getFirebaseFunctions } from "./client-app";

let appCheck: AppCheck | null = null;

/**
 * App Check — **App Check를 강제하는 함수를 부르기 직전에만** 켠다(2-K, 평가 건수 비용). 공급자는 Fraud Defense(이전 이름 reCAPTCHA Enterprise) —
 * reCAPTCHA 클래식 v3는 콘솔에서 새로 등록할 수 없음(11-09). 토큰 TTL은 콘솔에서 1시간.
 * - 가입 화면(`/join/parent`·`/join/staff`): 서버로 가입 QR 토큰을 확인해 폼을 보여 준 뒤, 강제 함수(로그인 ID 확인·번호 확인·가입)를 처음 부르기 직전.
 * - 번호 변경(학부모·직원 설정, 2-L): [인증 숫자 받기]로 `startPhoneVerification`을 부르기 직전.
 * 앱 전체·화면을 열기만 했을 때·잘못된 링크 안내 화면에서는 Fraud Defense 스크립트(`recaptcha/enterprise.js`)를 불러오지 않는다.
 * - `NEXT_PUBLIC_APPCHECK_SITE_KEY`(Fraud Defense 사이트 키)가 없으면 아무 것도 하지 않음(에뮬레이터·운영 강제 전).
 * - 자동 갱신 끔 — 그 화면에서 몇 번 부르는 동안만 쓰면 된다.
 * - 초기화 뒤 토큰을 한 번 받아 둔다: Functions SDK는 App Check를 비동기로 연결하므로, 기다리지 않으면 첫 호출에 토큰이 빠질 수 있다.
 *   토큰을 못 받아도 그대로 진행(서버가 강제 중이면 "Unauthenticated"로 거부 → 화면이 안내 문구로 바꿈).
 * - 에뮬레이터 디버그 토큰은 `NEXT_PUBLIC_APPCHECK_DEBUG_TOKEN`을 명시했을 때만.
 */
export async function ensureAppCheck(): Promise<void> {
  if (typeof window === "undefined") return;
  const siteKey = process.env.NEXT_PUBLIC_APPCHECK_SITE_KEY?.trim();
  if (!siteKey) return;
  if (!appCheck) {
    const dbg = process.env.NEXT_PUBLIC_APPCHECK_DEBUG_TOKEN?.trim();
    if (dbg) {
      (globalThis as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = dbg;
    }
    appCheck = initializeAppCheck(getFirebaseApp(), {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: false,
    });
  }
  try {
    await getToken(appCheck, false);
  } catch {
    /* 서버 거부 문구로 안내 */
  }
}

/**
 * 한 번씩 누르는 동작(가입 3개·번호 확인 조회, 2-L) — 부를 때마다 **1회용 App Check 토큰**을 새로 받는 Callable.
 * 서버는 토큰을 소비하므로 일반(재사용) 토큰으로 부르면 두 번째부터 거부된다. App Check를 켠 뒤(`ensureAppCheck`) 부를 것.
 */
export function oneShotCallable<Req = unknown, Res = unknown>(name: string): HttpsCallable<Req, Res> {
  return httpsCallable<Req, Res>(getFirebaseFunctions(), name, { limitedUseAppCheckTokens: true });
}
