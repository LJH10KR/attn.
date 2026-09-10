import { getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/**
 * Next.js 서버(App Hosting) 전용 firebase-admin 싱글톤.
 * App Hosting 런타임은 GCE 메타데이터 서버를 통해 자격증명을 자동 주입하므로
 * 서비스 계정 키 파일 없이 `applicationDefault()`만으로 초기화됩니다.
 * (`functions/src/index.ts`의 Admin SDK 초기화 패턴 참고 — 동일하게 앱 중복 초기화를 가드)
 */
function getAdminApp() {
  const existing = getApps();
  if (existing.length > 0) return existing[0];
  return initializeApp({
    credential: applicationDefault(),
    projectId:
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  });
}

export const adminDb: Firestore = getFirestore(getAdminApp());
