export type AppBadgeSyncOptions = {
  /** SW IndexedDB/Cache 키 — 학부모 uid 또는 `academy:{academyId}` */
  badgeUserId?: string;
};

function syncBadgeCountToServiceWorker(count: number, badgeUserId?: string): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  void (async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      reg.active?.postMessage({
        type: "ATTN_BADGE_SYNC",
        count: Math.max(0, Math.floor(count || 0)),
        parentUserId: badgeUserId ?? "",
      });
    } catch {
      /* ignore */
    }
  })();
}

/** 로그아웃 등 — 앱 아이콘 badge 제거 (알림 권한 없어도 clear 시도) */
export function clearAppIconBadge(options?: AppBadgeSyncOptions): void {
  try {
    if (typeof navigator !== "undefined") {
      const navAny = navigator as unknown as {
        clearAppBadge?: () => Promise<void> | void;
      };
      if (typeof navAny.clearAppBadge === "function") {
        void navAny.clearAppBadge();
      }
    }
  } catch {
    /* ignore */
  }
  syncBadgeCountToServiceWorker(0, options?.badgeUserId);
}

export function setAppIconBadgeCount(count: number, options?: AppBadgeSyncOptions): void {
  const n = Math.max(0, Math.floor(count || 0));
  try {
    if (typeof window === "undefined") return;
    if (typeof navigator === "undefined") return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;

    const navAny = navigator as unknown as {
      setAppBadge?: (badge: number) => Promise<void> | void;
      clearAppBadge?: () => Promise<void> | void;
    };

    if (typeof navAny.setAppBadge !== "function") return;

    if (n > 0) {
      void navAny.setAppBadge(n);
    } else if (typeof navAny.clearAppBadge === "function") {
      void navAny.clearAppBadge();
    }
  } catch {
    /* ignore */
  }

  syncBadgeCountToServiceWorker(n, options?.badgeUserId);
}

/** FCM data `appBadgeCount` — 포그라운드 푸시 수신 시 */
export function setAppIconBadgeFromPushData(
  data: Record<string, string | undefined> | undefined,
): void {
  if (!data) return;
  const raw = data.appBadgeCount;
  if (raw === undefined || raw === "") return;
  const parsed = parseInt(String(raw), 10);
  if (Number.isNaN(parsed) || parsed < 0) return;
  const uid = typeof data.parentUserId === "string" ? data.parentUserId : undefined;
  setAppIconBadgeCount(parsed, { badgeUserId: uid });
}
