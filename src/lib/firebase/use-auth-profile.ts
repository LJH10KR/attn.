"use client";

import { useCallback, useEffect, useState } from "react";
import { getFirebaseAuth } from "./client-app";
import { profilePhotoUrlForUser } from "./profile-photo-url";

export type AuthProfilePayload = {
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
  /** Firestore 회원 문서 등 — 프로필 메뉴 연락처 표시용 */
  phone?: string | null;
  googleLinked?: boolean;
  googleEmail?: string | null;
};

function profileFromCurrentUser(): AuthProfilePayload | null {
  const u = getFirebaseAuth().currentUser;
  if (!u) return null;
  return {
    displayName: u.displayName,
    email: u.email,
    photoURL: profilePhotoUrlForUser(u),
  };
}

export function useAuthProfile(): {
  profile: AuthProfilePayload | null;
  refreshProfile: () => Promise<void>;
} {
  const [p, setP] = useState<AuthProfilePayload | null>(null);

  const sync = useCallback(() => {
    setP(profileFromCurrentUser());
  }, []);

  const refreshProfile = useCallback(async () => {
    const u = getFirebaseAuth().currentUser;
    if (!u) {
      setP(null);
      return;
    }
    await u.reload();
    setP(profileFromCurrentUser());
  }, []);

  useEffect(() => {
    const auth = getFirebaseAuth();
    sync();
    const unsubAuth = auth.onAuthStateChanged(sync);
    const unsubToken = auth.onIdTokenChanged(sync);
    return () => {
      unsubAuth();
      unsubToken();
    };
  }, [sync]);

  return { profile: p, refreshProfile };
}
