"use client";

import type { User } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { getFirebaseFunctions } from "./client-app";

/** 사용자에게 Google 제공자가 연결돼 있는지 */
export function hasGoogleProvider(user: User): boolean {
  return user.providerData.some((p) => p?.providerId === "google.com");
}

/**
 * 3-A 후속 F2 — 이메일 미인증 원장이 인증 코드 창을 띄우기 전에 부른다.
 * Google 제공자가 연결돼 있으면 서버(`confirmGoogleEmailVerified`)가 Google 이메일과 계정 이메일을 비교해
 * 같을 때만 `emailVerified=true`로 바꾼다. 바뀌면 reload·토큰 갱신까지 마치고 true.
 *
 * - 이미 인증된 사용자는 서버를 부르지 않고 true.
 * - Google이 없거나 서버가 false·오류면 false → 호출한 쪽은 기존대로 인증 코드 창.
 * - true면 호출한 쪽은 원래 "인증됨" 분기(upsertOwnerProfile → 원래 가던 곳)로 이어 간다.
 */
export async function confirmGoogleEmailIfLinked(user: User): Promise<boolean> {
  if (user.emailVerified) return true;
  if (!hasGoogleProvider(user)) return false;
  try {
    const fn = httpsCallable<Record<string, never>, { verified?: boolean }>(
      getFirebaseFunctions(),
      "confirmGoogleEmailVerified",
    );
    const res = await fn({});
    if (res.data?.verified !== true) return false;
    await user.reload();
    await user.getIdToken(true);
    return user.emailVerified;
  } catch {
    return false;
  }
}
