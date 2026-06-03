"use client";

import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import type { User } from "firebase/auth";
import { COLLECTIONS } from "./attn-schema";
import { getFirebaseDb } from "./client-app";
import { profilePhotoUrlForUser } from "./profile-photo-url";

const OWNER_CHECK_TTL_MS = 60_000;
const ownerCheckCache = new Map<string, { value: boolean; expiresAt: number }>();
const ownerCheckInflight = new Map<string, Promise<boolean>>();

export type OwnerSignupProfileState = {
  isOwner: boolean;
  profileComplete: boolean;
  suggestedDisplayName: string;
  email: string | null;
};

/** Google 가입 직후 — 기존 오너·프로필 완료 여부 */
export async function fetchOwnerSignupProfileState(
  uid: string,
): Promise<OwnerSignupProfileState> {
  const snap = await getDoc(doc(getFirebaseDb(), COLLECTIONS.users, uid));
  const data = snap.data();
  const isOwner = snap.exists() && data?.platformRole === "owner";
  const phone = typeof data?.phone === "string" ? data.phone.trim() : "";
  const displayName =
    typeof data?.displayName === "string" ? data.displayName.trim() : "";
  return {
    isOwner,
    profileComplete: isOwner && Boolean(phone && displayName),
    suggestedDisplayName: displayName,
    email: typeof data?.email === "string" ? data.email : null,
  };
}

export async function fetchIsOwner(uid: string): Promise<boolean> {
  const now = Date.now();
  const cached = ownerCheckCache.get(uid);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inflight = ownerCheckInflight.get(uid);
  if (inflight) {
    return inflight;
  }

  const task = (async () => {
    const snap = await getDoc(doc(getFirebaseDb(), COLLECTIONS.users, uid));
    const value = snap.exists() && snap.data()?.platformRole === "owner";
    ownerCheckCache.set(uid, { value, expiresAt: Date.now() + OWNER_CHECK_TTL_MS });
    return value;
  })();

  ownerCheckInflight.set(uid, task);
  try {
    return await task;
  } finally {
    ownerCheckInflight.delete(uid);
  }
}

export type OwnerProfileExtras = {
  displayName?: string;
  phone?: string;
};

/** 이메일 인증 완료 후 또는 Google 신규 가입 직후 Firestore 오너 프로필을 맞춥니다. */
export async function upsertOwnerProfile(
  user: User,
  extras?: OwnerProfileExtras,
): Promise<void> {
  const db = getFirebaseDb();
  const ref = doc(db, COLLECTIONS.users, user.uid);
  const snap = await getDoc(ref);
  const displayName =
    extras?.displayName?.trim() || user.displayName?.trim() || null;
  const phone = extras?.phone?.trim() || null;
  const base = {
    email: user.email ?? null,
    displayName,
    phone,
    photoURL: profilePhotoUrlForUser(user),
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
