import type { User } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase/client-app";
import type { AuthProfilePayload } from "@/lib/firebase/use-auth-profile";

export type DashboardHeaderProfileExtras = {
  displayName?: string | null;
  phone?: string | null;
  /** Firestore 멤버 문서 — 없으면 Auth Google 연동 여부로 판별(오너 등) */
  googleLinked?: boolean;
  googleEmail?: string | null;
};

export function googleProviderEmailFromUser(user: User | null): string | null {
  const email = user?.providerData.find((p) => p.providerId === "google.com")?.email;
  return typeof email === "string" && email.trim() ? email.trim() : null;
}

export function userHasGoogleProvider(user: User | null): boolean {
  return Boolean(user?.providerData.some((p) => p.providerId === "google.com"));
}

/** 대시보드·설정 하단 프로필 메뉴용 — Firestore 멤버 정보 + Google 연동 반영 */
export function buildDashboardHeaderProfile(
  authProfile: AuthProfilePayload | null,
  extras?: DashboardHeaderProfileExtras,
): AuthProfilePayload | null {
  if (!authProfile) return null;

  const user = getFirebaseAuth().currentUser;
  const authGoogle = userHasGoogleProvider(user);
  const googleLinked = extras?.googleLinked ?? authGoogle;
  const googleEmail = googleLinked
    ? extras?.googleEmail?.trim() || googleProviderEmailFromUser(user) || null
    : null;

  const displayName = extras?.displayName?.trim() || authProfile.displayName;
  const phone =
    extras?.phone !== undefined && extras?.phone !== null
      ? extras.phone
      : authProfile.phone ?? null;

  return {
    ...authProfile,
    displayName,
    phone,
    googleLinked,
    googleEmail,
  };
}
