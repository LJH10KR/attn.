import { signOut } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase/client-app";
import { tearDownParentWebPushForLogout } from "@/lib/firebase/web-push";
import { clearAppIconBadge } from "@/lib/ios/app-badge";

export type LogoutRole = "parent" | "teacher" | "owner" | "academy" | "generic";

export type PerformLogoutOptions = {
  role?: LogoutRole;
  /** 추가로 0으로 맞출 badge 키 (예: `academy:{academyId}`) */
  extraBadgeUserIds?: string[];
  beforeSignOut?: () => Promise<void>;
};

async function resolveBadgeUserIdsForLogout(
  extra?: string[],
): Promise<string[]> {
  const ids = new Set<string>(extra ?? []);
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) {
    return [...ids];
  }
  ids.add(user.uid);
  try {
    const token = await user.getIdTokenResult();
    const academyId = token.claims.academyId;
    if (typeof academyId === "string" && academyId.trim()) {
      ids.add(`academy:${academyId.trim()}`);
    }
  } catch {
    /* ignore */
  }
  return [...ids];
}

/** 알림 badge 정리 → (선택) 푸시 해제 → Firebase signOut */
export async function performLogout(options: PerformLogoutOptions = {}): Promise<void> {
  const badgeIds = await resolveBadgeUserIdsForLogout(options.extraBadgeUserIds);
  for (const id of badgeIds) {
    clearAppIconBadge({ badgeUserId: id });
  }
  clearAppIconBadge();

  if (options.role === "parent") {
    await tearDownParentWebPushForLogout();
  }
  if (options.beforeSignOut) {
    await options.beforeSignOut();
  }

  const auth = getFirebaseAuth();
  if (auth.currentUser) {
    await signOut(auth);
  }
}
