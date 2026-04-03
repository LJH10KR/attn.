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
 * HTTP `onRequest` Functions 호출용 base URL.
 * - `NEXT_PUBLIC_API_BASE_URL`이 있으면 최우선.
 * - 에뮬레이터 모드면 `http://127.0.0.1:5001/{projectId}/{region}` 기본값.
 */
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
