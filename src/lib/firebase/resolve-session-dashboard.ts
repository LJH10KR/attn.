import type { User } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { getFirebaseFunctions } from "./client-app";
import { fetchIsOwner, upsertOwnerProfile } from "./owner-profile";

export type SessionRedirectResult = "redirected" | "stay";

/**
 * Firebase에 남아 있는 세션만으로 사용자의 기본 진입 경로를 결정합니다.
 * (앱 재실행·PWA 복원 시 홈/로그인에서 대시보드로 보낼 때 사용)
 */
export async function redirectIfKnownSessionDashboard(
  user: User,
  replace: (href: string) => void,
): Promise<SessionRedirectResult> {
  const { claims } = await user.getIdTokenResult();
  if (claims.role === "academy") {
    replace("/academy");
    return "redirected";
  }

  if (!user.emailVerified) {
    replace("/verify-email");
    return "redirected";
  }

  if (await fetchIsOwner(user.uid)) {
    await upsertOwnerProfile(user);
    replace("/owner");
    return "redirected";
  }

  const teacherPath = await getTeacherActivationPath();
  if (teacherPath) {
    replace(teacherPath);
    return "redirected";
  }

  const parentPath = await getParentActivationPath();
  if (parentPath) {
    replace(parentPath);
    return "redirected";
  }

  return "stay";
}

async function getTeacherActivationPath(): Promise<string | null> {
  const functions = getFirebaseFunctions();
  const fn = httpsCallable(functions, "getTeacherActivationState");
  const res = await fn({});
  const data = res.data as {
    anyActive?: boolean;
    primaryStatus?: string | null;
    primaryAcademyId?: string | null;
  };

  if (data?.anyActive) return "/teacher";

  const state = data?.primaryStatus ?? null;
  const academyId = data?.primaryAcademyId ?? "";

  if (state == null) {
    return null;
  }

  if (state === "invitation_sent") {
    const p = new URLSearchParams();
    if (academyId) p.set("academyId", academyId);
    const qs = p.toString();
    return `/teacher/complete${qs ? `?${qs}` : ""}`;
  }

  const q = new URLSearchParams();
  q.set("state", state);
  if (academyId) q.set("academyId", academyId);
  return `/teacher/session?${q.toString()}`;
}

async function getParentActivationPath(): Promise<string | null> {
  const functions = getFirebaseFunctions();
  const fn = httpsCallable(functions, "getParentActivationState");
  const res = await fn({});
  const data = res.data as {
    anyActive?: boolean;
    primaryStatus?: string | null;
    primaryAcademyId?: string | null;
  };

  if (data?.anyActive) return "/parent";

  const state = data?.primaryStatus ?? null;
  const aid = data?.primaryAcademyId ?? "";

  if (state == null) {
    return null;
  }

  if (state === "invitation_sent") {
    const p = new URLSearchParams();
    if (aid) p.set("academyId", aid);
    const qs = p.toString();
    return `/parent/complete${qs ? `?${qs}` : ""}`;
  }

  const q = new URLSearchParams();
  q.set("state", state);
  if (aid) q.set("academyId", aid);
  return `/parent/session?${q.toString()}`;
}

/** 로그인 페이지에서 자동 리다이렉트를 건너뛸지 (역할 탭·안내 메시지·강제 체류) */
export function shouldSkipLoginSessionAutoRedirect(searchParams: URLSearchParams): boolean {
  return searchParams.has("stay") || searchParams.has("role") || searchParams.has("msg");
}
