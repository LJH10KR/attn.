import { NextResponse } from "next/server";
import { firebaseWebConfig } from "@/lib/firebase/config";

/**
 * FCM 백그라운드 수신용 서비스 워커 스크립트.
 * `next.config.ts`에서 `/firebase-messaging-sw.js`로 리라이트합니다.
 * Firebase JS 버전은 루트 package.json의 `firebase`와 맞출 것.
 */
export async function GET() {
  const swFirebaseVersion = "12.11.0";
  const cfg = {
    apiKey: firebaseWebConfig.apiKey,
    authDomain: firebaseWebConfig.authDomain,
    projectId: firebaseWebConfig.projectId,
    storageBucket: firebaseWebConfig.storageBucket,
    messagingSenderId: firebaseWebConfig.messagingSenderId,
    appId: firebaseWebConfig.appId,
  };
  const body = `importScripts("https://www.gstatic.com/firebasejs/${swFirebaseVersion}/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/${swFirebaseVersion}/firebase-messaging-compat.js");
firebase.initializeApp(${JSON.stringify(cfg)});
const messaging = firebase.messaging();

const ATTN_BADGE_CACHE = "attn-app-badge-v1";

function attnBadgeStorageKey(uid) {
  return "https://attn.local/app-badge/" + encodeURIComponent(uid || "default");
}

async function attnReadPersistedBadge(uid) {
  try {
    const cache = await caches.open(ATTN_BADGE_CACHE);
    const res = await cache.match(attnBadgeStorageKey(uid));
    if (!res) return 0;
    const n = parseInt(await res.text(), 10);
    return Number.isNaN(n) || n < 0 ? 0 : n;
  } catch (e) {
    return 0;
  }
}

async function attnWritePersistedBadge(uid, count) {
  try {
    const cache = await caches.open(ATTN_BADGE_CACHE);
    const n = Math.max(0, Math.floor(count || 0));
    await cache.put(attnBadgeStorageKey(uid), new Response(String(n)));
  } catch (e) {
    // ignore
  }
}

function attnApplyAppBadge(count) {
  try {
    if (typeof self.navigator === "undefined" || !self.navigator) return;
    const n = Math.max(0, Math.floor(count || 0));
    if (typeof self.navigator.setAppBadge !== "function") return;
    if (n > 0) {
      self.navigator.setAppBadge(n);
    } else if (typeof self.navigator.clearAppBadge === "function") {
      self.navigator.clearAppBadge();
    }
  } catch (e) {
    // ignore
  }
}

async function attnResolveBadgeFromPushData(data) {
  const uid = typeof data.parentUserId === "string" ? data.parentUserId : "";
  let count = null;
  if (data.appBadgeCount !== undefined && data.appBadgeCount !== "") {
    const parsed = parseInt(String(data.appBadgeCount), 10);
    if (!Number.isNaN(parsed) && parsed >= 0) count = parsed;
  }
  if (count === null) {
    const prev = uid ? await attnReadPersistedBadge(uid) : 0;
    const incRaw = data.badgeIncrement;
    const inc = parseInt(String(incRaw != null ? incRaw : "1"), 10);
    const step = !Number.isNaN(inc) && inc > 0 ? inc : 1;
    count = prev + step;
  }
  if (uid) await attnWritePersistedBadge(uid, count);
  attnApplyAppBadge(count);
  return count;
}

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.type !== "ATTN_BADGE_SYNC") return;
  const uid = typeof msg.parentUserId === "string" ? msg.parentUserId : "";
  const raw = msg.count;
  const parsed = typeof raw === "number" ? raw : parseInt(String(raw || 0), 10);
  const n = Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
  if (uid) {
    attnWritePersistedBadge(uid, n);
  }
  attnApplyAppBadge(n);
});

messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const title = typeof data.title === "string" && data.title.length > 0 ? data.title : "attn.";
  const bodyText = typeof data.body === "string" ? data.body : "";
  const badgePromise = attnResolveBadgeFromPushData(data);
  const options = {
    body: bodyText,
    icon: "/icon.png",
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, typeof v === "string" ? v : String(v ?? "")]),
    ),
  };
  const notifPromise = self.registration.showNotification(title, options);
  return Promise.all([badgePromise, notifPromise]);
});
`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // SW 스크립트가 오래 캐시되면 설정·Firebase 버전 변경 후에도 구버전이 남을 수 있음
      "Cache-Control": "no-store",
      "Service-Worker-Allowed": "/",
    },
  });
}
