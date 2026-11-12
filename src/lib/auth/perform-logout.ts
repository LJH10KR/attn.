import { signOut } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase/client-app";
import { tearDownParentWebPushForLogout } from "@/lib/firebase/web-push";
import { clearAppIconBadge } from "@/lib/ios/app-badge";

export type LogoutRole = "parent" | "teacher" | "owner" | "generic";

export type PerformLogoutOptions = {
  role?: LogoutRole;
  /** 추가로 0으로 맞출 badge 키 (예: `academy:{academyId}`) */
  extraBadgeUserIds?: string[];
  beforeSignOut?: () => Promise<void>;
  /**
   * 서버를 부르지 않고 이 기기만 정리(2-N 회원 탈퇴 완료 화면) — 서버는 이미 계정 데이터·Auth를 지웠고,
   * 아직 유효한 ID 토큰으로 서버 정리(푸시 끄기)를 부르면 지운 `users/{uid}`가 다시 생김.
   */
  localOnly?: boolean;
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
    await tearDownParentWebPushForLogout({ localOnly: options.localOnly });
  }
  if (options.beforeSignOut) {
    await options.beforeSignOut();
  }

  const auth = getFirebaseAuth();
  if (auth.currentUser) {
    await signOut(auth);
  }
}
