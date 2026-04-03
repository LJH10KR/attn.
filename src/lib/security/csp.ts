/**
 * XSS 완화용 Content-Security-Policy 문자열.
 * - Next.js가 주입하는 스크립트는 미들웨어에서 생성한 nonce + strict-dynamic으로 허용.
 * - 개발(Turbopack)은 eval/HMR을 위해 unsafe-eval을 추가.
 * - Firebase Auth / Google 로그인에 필요한 호스트를 connect-src·frame-src에 포함.
 */

const FIREBASE_CONNECT =
  "https://*.googleapis.com https://*.gstatic.com https://*.firebaseio.com wss://*.firebaseio.com " +
  "https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firebase.googleapis.com " +
  "https://www.googleapis.com https://firebaseinstallations.googleapis.com https://apis.google.com https://www.google.com " +
  "https://fcmregistrations.googleapis.com " +
  "wss://*.googleapis.com";

const EMULATOR_CONNECT =
  "http://127.0.0.1:5001 http://127.0.0.1:8080 http://127.0.0.1:9099 " +
  "http://localhost:5001 http://localhost:8080 http://localhost:9099 " +
  "ws://127.0.0.1:8080 ws://localhost:8080";

const EMULATOR_FRAME =
  "http://127.0.0.1:9099 http://localhost:9099";

export function generateCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function buildContentSecurityPolicy(opts: { nonce: string; isDev: boolean }): string {
  const { nonce, isDev } = opts;
  const scriptDev = isDev ? " 'unsafe-eval'" : "";

  const directives: string[] = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${scriptDev} https://www.gstatic.com https://apis.google.com https://www.google.com https://accounts.google.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${FIREBASE_CONNECT}${isDev ? ` ${EMULATOR_CONNECT}` : ""}`,
    `frame-src 'self' https://accounts.google.com https://www.google.com https://www.gstatic.com https://*.firebaseapp.com https://*.google.com${isDev ? ` ${EMULATOR_FRAME}` : ""}`,
  ];

  if (!isDev) {
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
}
