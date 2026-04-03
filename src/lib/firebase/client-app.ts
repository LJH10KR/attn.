"use client";

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore, type Firestore } from "firebase/firestore";
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
  if (typeof window !== "undefined" && isFirebaseEmulatorEnabled() && !authEmulatorConnected) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    authEmulatorConnected = true;
  }
  return auth;
}

export function getFirebaseDb(): Firestore {
  const app = getOrInitApp();
  const db = getFirestore(app);
  if (typeof window !== "undefined" && isFirebaseEmulatorEnabled() && !firestoreEmulatorConnected) {
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    firestoreEmulatorConnected = true;
  }
  return db;
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
