"use client";

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import { connectFirestoreEmulator, initializeFirestore, type Firestore } from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, type Functions } from "firebase/functions";
import {
  FIREBASE_FUNCTIONS_REGION,
  firebaseWebConfig,
  isFirebaseConfigured,
  isFirebaseEmulatorEnabled,
} from "./config";
import { initFirebaseAppCheck } from "./app-check";

let authEmulatorConnected = false;
let firestoreEmulatorConnected = false;
let functionsEmulatorConnected = false;
let firestoreInstance: Firestore | null = null;

function getOrInitApp(): FirebaseApp {
  if (!isFirebaseConfigured()) {
    throw new Error(
      "Firebase 웹 설정이 비어 있습니다. .env.local에 NEXT_PUBLIC_FIREBASE_* 변수를 채워 주세요.",
    );
  }
  const existing = getApps()[0];
  if (existing) {
    initFirebaseAppCheck(existing);
    return existing;
  }
  const app = initializeApp(firebaseWebConfig);
  initFirebaseAppCheck(app);
  return app;
}

/** 브라우저에서만 호출. */
export function getFirebaseAuth(): Auth {
  const app = getOrInitApp();
  const auth = getAuth(app);
  if (typeof window !== "undefined") {
    // Firebase useDeviceLanguage는 React 훅이 아니지만 ESLint가 오탐함 → navigator 사용.
    const primary =
      typeof navigator !== "undefined" && navigator.language
        ? navigator.language.split("-")[0]
        : "ko";
    auth.languageCode = primary || "ko";
  }
  if (typeof window !== "undefined" && isFirebaseEmulatorEnabled() && !authEmulatorConnected) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    authEmulatorConnected = true;
  }
  return auth;
}

export function getFirebaseDb(): Firestore {
  const app = getOrInitApp();
  if (!firestoreInstance) {
    const emulator = typeof window !== "undefined" && isFirebaseEmulatorEnabled();
    firestoreInstance = emulator
      ? initializeFirestore(app, { experimentalForceLongPolling: true })
      : initializeFirestore(app, {});
  }
  const db = firestoreInstance;
  if (typeof window !== "undefined" && isFirebaseEmulatorEnabled() && !firestoreEmulatorConnected) {
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    firestoreEmulatorConnected = true;
  }
  return db;
}

/**
 * 첫 Firestore 구독/쿼리 직전에 호출하면 Auth 초기화·ID 토큰이 먼저 잡혀
 * (특히 에뮬레이터 + 로그인 직후) 빈 스냅샷만 오는 현상을 줄일 수 있습니다.
 */
export async function getFirebaseDbAfterAuthReady(): Promise<Firestore> {
  if (typeof window !== "undefined") {
    const auth = getFirebaseAuth();
    await auth.authStateReady();
    const u = auth.currentUser;
    if (u) {
      await u.getIdToken();
    }
  }
  return getFirebaseDb();
}

export function getFirebaseFunctions(): Functions {
  const app = getOrInitApp();
  const functions = getFunctions(app, FIREBASE_FUNCTIONS_REGION);
  if (typeof window !== "undefined" && isFirebaseEmulatorEnabled() && !functionsEmulatorConnected) {
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
    functionsEmulatorConnected = true;
  }
  return functions;
}
