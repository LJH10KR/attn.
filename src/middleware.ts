import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { academyMenuPath, academyPath } from "@/lib/academy/academy-routes";
import type { AcademyPermission } from "@/lib/academy/permissions";
import { buildContentSecurityPolicy, generateCspNonce } from "@/lib/security/csp";

/** 예전 대시보드 `?section=` → 상세 메뉴 */
const LEGACY_ACADEMY_SECTIONS: Record<string, AcademyPermission> = {
  parents: "operations.parents",
  students: "operations.students",
  notifications: "lessons.notificationLog",
  teachers: "settings.members",
};

/** 예전 `?id=` 화면 → 상세 메뉴 */
const LEGACY_ACADEMY_PAGES: Record<string, AcademyPermission> = {
  "/academy/payments": "billing.payments",
  "/academy/settings": "settings.general",
  "/academy/settings/staff": "settings.staff",
  "/academy/settings/members": "settings.members",
};

/**
 * 예전 학원 주소(`/academy?id=…&section=…`, `/academy/payments?id=…` 등) → `/academy/[academyId]/…`.
 * `id`·`section`만 빼고 다른 쿼리(`from=owner`, `tab=roles`)는 유지. 학원 ID가 없으면 `/academy`(진입 화면).
 */
function legacyAcademyRedirect(request: NextRequest): URL | null {
  const { pathname, searchParams } = request.nextUrl;
  const id = searchParams.get("id")?.trim() ?? "";
  let target: string;
  if (pathname === "/academy") {
    if (!searchParams.has("id") && !searchParams.has("section")) return null;
    const section = LEGACY_ACADEMY_SECTIONS[searchParams.get("section") ?? ""];
    target = !id ? "/academy" : section ? academyMenuPath(id, section) : academyPath(id);
  } else {
    const permission = LEGACY_ACADEMY_PAGES[pathname];
    if (!permission) return null;
    target = id ? academyMenuPath(id, permission) : "/academy";
  }
  const url = request.nextUrl.clone();
  url.pathname = target;
  url.searchParams.delete("id");
  url.searchParams.delete("section");
  return url;
}

export function middleware(request: NextRequest) {
  const legacy = legacyAcademyRedirect(request);
  if (legacy) return NextResponse.redirect(legacy);

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
