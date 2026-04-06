"use client";

import { useEffect, useState } from "react";
import { getFirebaseAuth } from "./client-app";
import { profilePhotoUrlForUser } from "./profile-photo-url";

export type AuthProfilePayload = {
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
};

export function useAuthProfile(): AuthProfilePayload | null {
  const [p, setP] = useState<AuthProfilePayload | null>(null);
  useEffect(() => {
    const auth = getFirebaseAuth();
    const sync = () => {
      const u = auth.currentUser;
      setP(
        u
          ? {
              displayName: u.displayName,
              email: u.email,
              photoURL: profilePhotoUrlForUser(u),
            }
          : null,
      );
    };
    sync();
    return auth.onAuthStateChanged(sync);
  }, []);
  return p;
}
