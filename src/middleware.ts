import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { buildContentSecurityPolicy, generateCspNonce } from "@/lib/security/csp";

export function middleware(request: NextRequest) {
  const isDev = process.env.NODE_ENV === "development";
  const nonce = generateCspNonce();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  response.headers.set("Content-Security-Policy", buildContentSecurityPolicy({ nonce, isDev }));
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "DENY");
  /**
   * 개발: 앱(localhost) ↔ Auth 에뮬레이터(127.0.0.1:9099) 팝업이 서로 다른 오리진이라
   * COOP(same-origin-allow-popups)가 postMessage/iframe 릴레이를 깨 "No matching frame" 유발.
   * 프로덕션만 COOP 유지.
   */
  if (!isDev) {
    response.headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  }
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
