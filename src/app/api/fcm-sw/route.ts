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
messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const title = typeof data.title === "string" && data.title.length > 0 ? data.title : "attn.";
  const bodyText = typeof data.body === "string" ? data.body : "";
  const options = {
    body: bodyText,
    icon: "/icon.png",
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, typeof v === "string" ? v : String(v ?? "")]),
    ),
  };
  return self.registration.showNotification(title, options);
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
