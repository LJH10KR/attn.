"use client";

import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import type { User } from "firebase/auth";
import { COLLECTIONS } from "./attn-schema";
import { getFirebaseDb } from "./client-app";

export async function fetchIsOwner(uid: string): Promise<boolean> {
  const snap = await getDoc(doc(getFirebaseDb(), COLLECTIONS.users, uid));
  if (!snap.exists()) {
    return false;
  }
  return snap.data()?.platformRole === "owner";
}

/** 이메일 인증 완료 후 또는 Google 신규 가입 직후 Firestore 오너 프로필을 맞춥니다. */
export async function upsertOwnerProfile(user: User): Promise<void> {
  const db = getFirebaseDb();
  const ref = doc(db, COLLECTIONS.users, user.uid);
  const snap = await getDoc(ref);
  const base = {
    email: user.email ?? null,
    displayName: user.displayName ?? null,
    photoURL: user.photoURL ?? null,
    platformRole: "owner" as const,
    emailVerified: user.emailVerified,
    updatedAt: serverTimestamp(),
    ...(user.emailVerified ? { ownerOnboardedAt: serverTimestamp() } : {}),
  };
  await setDoc(
    ref,
    snap.exists() ? base : { ...base, createdAt: serverTimestamp() },
    { merge: true },
  );
}
