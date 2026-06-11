export const FIREBASE_FUNCTIONS_REGION = "asia-northeast3";

export const firebaseWebConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID ?? "",
};

export function isFirebaseConfigured(): boolean {
  return Boolean(
    firebaseWebConfig.apiKey &&
      firebaseWebConfig.projectId &&
      firebaseWebConfig.appId,
  );
}

export function isFirebaseEmulatorEnabled(): boolean {
  return process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === "1";
}

/**
 * 활성 미러(`users/{uid}/serverMirror/activation`)를 Callable보다 먼저 읽을지.
 * 기본값은 `false`(Callable만 사용) — Functions·규칙·백필을 확인한 뒤 `NEXT_PUBLIC_USE_ACTIVATION_MIRROR_READ=1`로 켭니다.
 */
export function isActivationMirrorClientReadEnabled(): boolean {
  return process.env.NEXT_PUBLIC_USE_ACTIVATION_MIRROR_READ === "1";
}

/** FCM 웹용 VAPID 공개 키 — Firebase 콘솔 > 프로젝트 설정 > 클라우드 메시징 > 웹 푸시 인증서 */
export function getFirebaseWebVapidKey(): string {
  return process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY?.trim() ?? "";
}

export function isWebPushConfigured(): boolean {
  return Boolean(getFirebaseWebVapidKey());
}

/**
 * HTTP `onRequest` Functions 호출용 base URL.
 * - `NEXT_PUBLIC_API_BASE_URL`이 있으면 최우선.
 * - 에뮬레이터 모드면 `http://127.0.0.1:5001/{projectId}/{region}` 기본값.
 */
/**
 * 공개 앱 URL — 학부모 가입 링크 복사 등.
 * `NEXT_PUBLIC_APP_ORIGIN`이 있으면 hosted.app 대신 커스텀 도메인을 사용합니다.
 */
export function getPublicAppOrigin(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_ORIGIN?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "";
}

export function getApiBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }
  if (isFirebaseEmulatorEnabled() && firebaseWebConfig.projectId) {
    return `http://127.0.0.1:5001/${firebaseWebConfig.projectId}/${FIREBASE_FUNCTIONS_REGION}`;
  }
  return "";
}
