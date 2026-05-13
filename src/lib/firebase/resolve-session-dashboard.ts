import type { User } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { isRoleLoginPath } from "@/lib/auth/login-routes";
import { getFirebaseFunctions } from "./client-app";
import { fetchIsOwner, upsertOwnerProfile } from "./owner-profile";

export type SessionRedirectResult = "redirected" | "stay";

const ACTIVATION_CACHE_TTL_MS = 45_000;
const SESSION_DECISION_CACHE_TTL_MS = 3_000;

type ActivationCacheEntry = {
  path: string | null;
  cachedAt: number;
};

let teacherActivationCache: ActivationCacheEntry | null = null;
let parentActivationCache: ActivationCacheEntry | null = null;
const sessionDecisionInFlightByUid = new Map<string, Promise<string | null>>();
const recentSessionDecisionByUid = new Map<
  string,
  { path: string | null; cachedAt: number }
>();

function isCacheFresh(
  entry: ActivationCacheEntry | null,
  maxAgeMs: number,
): entry is ActivationCacheEntry {
  if (!entry) return false;
  return Date.now() - entry.cachedAt <= maxAgeMs;
}

function setTeacherActivationCache(path: string | null): void {
  teacherActivationCache = { path, cachedAt: Date.now() };
}

function setParentActivationCache(path: string | null): void {
  parentActivationCache = { path, cachedAt: Date.now() };
}

/**
 * Firebase에 남아 있는 세션만으로 사용자의 기본 진입 경로를 결정합니다.
 * (앱 재실행·PWA 복원 시 홈/로그인에서 대시보드로 보낼 때 사용)
 */
export async function redirectIfKnownSessionDashboard(
  user: User,
  replace: (href: string) => void,
): Promise<SessionRedirectResult> {
  const destination = await resolveKnownSessionDashboardPath(user);
  if (destination) {
    replace(destination);
    return "redirected";
  }
  return "stay";
}

async function resolveKnownSessionDashboardPath(user: User): Promise<string | null> {
  const uid = user.uid;
  const cached = recentSessionDecisionByUid.get(uid);
  if (cached && Date.now() - cached.cachedAt <= SESSION_DECISION_CACHE_TTL_MS) {
    return cached.path;
  }

  const inFlight = sessionDecisionInFlightByUid.get(uid);
  if (inFlight) {
    return inFlight;
  }

  const decisionPromise = (async (): Promise<string | null> => {
  const { claims } = await user.getIdTokenResult();
  if (claims.role === "academy") {
    return "/academy";
  }

  if (!user.emailVerified) {
    return "/verify-email";
  }

  /**
   * 선생님·학부모를 오너보다 먼저 본다. 오너 탭으로 한 번 로그인하면 `users`에
   * `platformRole: owner`가 merge되어, 실제로는 선생님만 쓰는 계정도 fetchIsOwner가
   * 참이 될 수 있기 때문이다.
   */
  const [teacherPath, parentPath] = await Promise.all([
    resolveTeacherActivationPath(),
    resolveParentActivationPath(),
  ]);

  if (teacherPath) {
    return teacherPath;
  }

  if (parentPath) {
    return parentPath;
  }

  if (await fetchIsOwner(user.uid)) {
    await upsertOwnerProfile(user);
    return "/owner";
  }

    return null;
  })();

  sessionDecisionInFlightByUid.set(uid, decisionPromise);
  try {
    const path = await decisionPromise;
    recentSessionDecisionByUid.set(uid, { path, cachedAt: Date.now() });
    return path;
  } finally {
    sessionDecisionInFlightByUid.delete(uid);
  }
}

export async function resolveTeacherActivationPath(
  opts?: { maxCacheAgeMs?: number; bypassCache?: boolean },
): Promise<string | null> {
  const maxAgeMs = opts?.maxCacheAgeMs ?? ACTIVATION_CACHE_TTL_MS;
  if (!opts?.bypassCache && isCacheFresh(teacherActivationCache, maxAgeMs)) {
    return teacherActivationCache.path;
  }
  const functions = getFirebaseFunctions();
  const fn = httpsCallable(functions, "getTeacherActivationState");
  const res = await fn({});
  const data = res.data as {
    anyActive?: boolean;
    primaryStatus?: string | null;
    primaryAcademyId?: string | null;
  };

  if (data?.anyActive) {
    setTeacherActivationCache("/teacher");
    return "/teacher";
  }

  const state = data?.primaryStatus ?? null;
  const academyId = data?.primaryAcademyId ?? "";

  if (state == null) {
    setTeacherActivationCache(null);
    return null;
  }

  if (state === "invitation_sent") {
    const p = new URLSearchParams();
    if (academyId) p.set("academyId", academyId);
    const qs = p.toString();
    const path = `/teacher/complete${qs ? `?${qs}` : ""}`;
    setTeacherActivationCache(path);
    return path;
  }

  const q = new URLSearchParams();
  q.set("state", state);
  if (academyId) q.set("academyId", academyId);
  const path = `/teacher/session?${q.toString()}`;
  setTeacherActivationCache(path);
  return path;
}

export async function resolveParentActivationPath(
  opts?: { maxCacheAgeMs?: number; bypassCache?: boolean },
): Promise<string | null> {
  const maxAgeMs = opts?.maxCacheAgeMs ?? ACTIVATION_CACHE_TTL_MS;
  if (!opts?.bypassCache && isCacheFresh(parentActivationCache, maxAgeMs)) {
    return parentActivationCache.path;
  }
  const functions = getFirebaseFunctions();
  const fn = httpsCallable(functions, "getParentActivationState");
  const res = await fn({});
  const data = res.data as {
    anyActive?: boolean;
    primaryStatus?: string | null;
    primaryAcademyId?: string | null;
  };

  if (data?.anyActive) {
    setParentActivationCache("/parent");
    return "/parent";
  }

  const state = data?.primaryStatus ?? null;
  const aid = data?.primaryAcademyId ?? "";

  if (state == null) {
    setParentActivationCache(null);
    return null;
  }

  if (state === "invitation_sent") {
    const p = new URLSearchParams();
    if (aid) p.set("academyId", aid);
    const qs = p.toString();
    const path = `/parent/complete${qs ? `?${qs}` : ""}`;
    setParentActivationCache(path);
    return path;
  }

  const q = new URLSearchParams();
  q.set("state", state);
  if (aid) q.set("academyId", aid);
  const path = `/parent/session?${q.toString()}`;
  setParentActivationCache(path);
  return path;
}

/** 로그인 페이지에서 자동 리다이렉트를 건너뛸지 (역할 경로·쿼리 안내·강제 체류) */
export function shouldSkipLoginSessionAutoRedirect(
  searchParams: URLSearchParams,
  pathname?: string,
): boolean {
  if (pathname && isRoleLoginPath(pathname)) return true;
  return (
    searchParams.has("stay") ||
    searchParams.has("role") ||
    searchParams.has("msg")
  );
}
