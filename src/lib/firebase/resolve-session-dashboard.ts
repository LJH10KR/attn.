"use client";

import type { User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { isRoleLoginPath } from "@/lib/auth/login-routes";
import {
  getFirebaseDbAfterAuthReady,
  getFirebaseFunctions,
} from "./client-app";
import { isActivationMirrorClientReadEnabled } from "./config";
import {
  COLLECTIONS,
  USER_ACTIVATION_MIRROR_DOC_ID,
  USER_ACTIVATION_MIRROR_SCHEMA_VERSION,
  USER_SERVER_MIRROR_COLLECTION,
} from "./attn-schema";
import { fetchIsOwner, upsertOwnerProfile } from "./owner-profile";

export type SessionRedirectResult = "redirected" | "stay";

const ACTIVATION_CACHE_TTL_MS = 45_000;
const SESSION_DECISION_CACHE_TTL_MS = 3_000;

export type RoleActivationState = {
  anyActive: boolean;
  primaryStatus: string | null;
  primaryAcademyId: string | null;
};

type ActivationCacheEntry = {
  state: RoleActivationState;
  cachedAt: number;
};

const teacherActivationCacheByUid = new Map<string, ActivationCacheEntry>();
const parentActivationCacheByUid = new Map<string, ActivationCacheEntry>();
const teacherActivationInFlightByUid = new Map<string, Promise<RoleActivationState>>();
const parentActivationInFlightByUid = new Map<string, Promise<RoleActivationState>>();
const sessionDecisionInFlightByUid = new Map<string, Promise<string | null>>();
const recentSessionDecisionByUid = new Map<
  string,
  { path: string | null; cachedAt: number }
>();

function isCacheFresh(
  entry: ActivationCacheEntry | undefined,
  maxAgeMs: number,
): entry is ActivationCacheEntry {
  if (!entry) return false;
  return Date.now() - entry.cachedAt <= maxAgeMs;
}

async function tryReadActivationRoleFromMirror(
  user: User,
  role: "teacher" | "parent",
): Promise<RoleActivationState | null> {
  try {
    const db = await getFirebaseDbAfterAuthReady();
    const ref = doc(
      db,
      COLLECTIONS.users,
      user.uid,
      USER_SERVER_MIRROR_COLLECTION,
      USER_ACTIVATION_MIRROR_DOC_ID,
    );
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const data = snap.data();
    if (data.schemaVersion !== USER_ACTIVATION_MIRROR_SCHEMA_VERSION) return null;
    const slice = data[role];
    if (!slice || typeof slice !== "object") return null;
    return normalizeActivationState(
      slice as {
        anyActive?: boolean;
        primaryStatus?: string | null;
        primaryAcademyId?: string | null;
      },
    );
  } catch {
    return null;
  }
}

function normalizeActivationState(data: {
  anyActive?: boolean;
  primaryStatus?: string | null;
  primaryAcademyId?: string | null;
}): RoleActivationState {
  return {
    anyActive: data?.anyActive === true,
    primaryStatus:
      typeof data?.primaryStatus === "string" ? data.primaryStatus : null,
    primaryAcademyId:
      typeof data?.primaryAcademyId === "string" && data.primaryAcademyId
        ? data.primaryAcademyId
        : null,
  };
}

function activationPathFromState(
  role: "teacher" | "parent",
  state: RoleActivationState,
): string | null {
  if (state.anyActive) {
    return `/${role}`;
  }
  if (!state.primaryStatus) {
    return null;
  }
  if (state.primaryStatus === "pending_setup") {
    return `/${role}/setup`;
  }
  if (state.primaryStatus === "invitation_sent") {
    const p = new URLSearchParams();
    if (state.primaryAcademyId) p.set("academyId", state.primaryAcademyId);
    const qs = p.toString();
    return `/${role}/complete${qs ? `?${qs}` : ""}`;
  }
  const q = new URLSearchParams();
  q.set("state", state.primaryStatus);
  if (state.primaryAcademyId) q.set("academyId", state.primaryAcademyId);
  return `/${role}/session?${q.toString()}`;
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
  // 안정성 보호 가드:
  // 1) UID 스코프 캐시만 재사용
  // 2) 짧은 TTL 캐시(SESSION_DECISION_CACHE_TTL_MS)
  // 3) 동일 UID in-flight dedupe
  // 4) fallback 경로(owner 판별) 유지
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

    const authEmail = user.email ?? "";
    const isProvisionInternalEmail = authEmail.includes("@provision.attndot.internal");
    if (!user.emailVerified && !isProvisionInternalEmail) {
      return "/login/owner";
    }

    /**
     * 선생님·학부모를 오너보다 먼저 본다. 오너 탭으로 한 번 로그인하면 `users`에
     * `platformRole: owner`가 merge되어, 실제로는 선생님만 쓰는 계정도 fetchIsOwner가
     * 참이 될 수 있기 때문이다.
     */
    const [teacherPath, parentPath] = await Promise.all([
      resolveTeacherActivationPath(user),
      resolveParentActivationPath(user),
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
  user: User,
  opts?: { maxCacheAgeMs?: number; bypassCache?: boolean },
): Promise<string | null> {
  const state = await resolveTeacherActivationState(user, opts);
  return activationPathFromState("teacher", state);
}

export async function resolveTeacherActivationState(
  user: User,
  opts?: { maxCacheAgeMs?: number; bypassCache?: boolean },
): Promise<RoleActivationState> {
  const uid = user.uid;
  const maxAgeMs = opts?.maxCacheAgeMs ?? ACTIVATION_CACHE_TTL_MS;
  if (!opts?.bypassCache) {
    const cached = teacherActivationCacheByUid.get(uid);
    if (isCacheFresh(cached, maxAgeMs)) {
      return cached.state;
    }
    const inFlight = teacherActivationInFlightByUid.get(uid);
    if (inFlight) return inFlight;
  }
  const task = (async (): Promise<RoleActivationState> => {
    if (isActivationMirrorClientReadEnabled()) {
      const fromMirror = await tryReadActivationRoleFromMirror(user, "teacher");
      if (fromMirror) {
        teacherActivationCacheByUid.set(uid, { state: fromMirror, cachedAt: Date.now() });
        return fromMirror;
      }
    }

    const functions = getFirebaseFunctions();
    const fn = httpsCallable(functions, "getTeacherActivationState");
    const res = await fn({});
    const state = normalizeActivationState(
      res.data as {
        anyActive?: boolean;
        primaryStatus?: string | null;
        primaryAcademyId?: string | null;
      },
    );
    teacherActivationCacheByUid.set(uid, { state, cachedAt: Date.now() });
    return state;
  })();
  teacherActivationInFlightByUid.set(uid, task);
  try {
    return await task;
  } finally {
    teacherActivationInFlightByUid.delete(uid);
  }
}

export async function resolveParentActivationPath(
  user: User,
  opts?: { maxCacheAgeMs?: number; bypassCache?: boolean },
): Promise<string | null> {
  const state = await resolveParentActivationState(user, opts);
  return activationPathFromState("parent", state);
}

export async function resolveParentActivationState(
  user: User,
  opts?: { maxCacheAgeMs?: number; bypassCache?: boolean },
): Promise<RoleActivationState> {
  const uid = user.uid;
  const maxAgeMs = opts?.maxCacheAgeMs ?? ACTIVATION_CACHE_TTL_MS;
  if (!opts?.bypassCache) {
    const cached = parentActivationCacheByUid.get(uid);
    if (isCacheFresh(cached, maxAgeMs)) {
      return cached.state;
    }
    const inFlight = parentActivationInFlightByUid.get(uid);
    if (inFlight) return inFlight;
  }
  const task = (async (): Promise<RoleActivationState> => {
    if (isActivationMirrorClientReadEnabled()) {
      const fromMirror = await tryReadActivationRoleFromMirror(user, "parent");
      if (fromMirror) {
        parentActivationCacheByUid.set(uid, { state: fromMirror, cachedAt: Date.now() });
        return fromMirror;
      }
    }

    const functions = getFirebaseFunctions();
    const fn = httpsCallable(functions, "getParentActivationState");
    const res = await fn({});
    const state = normalizeActivationState(
      res.data as {
        anyActive?: boolean;
        primaryStatus?: string | null;
        primaryAcademyId?: string | null;
      },
    );
    parentActivationCacheByUid.set(uid, { state, cachedAt: Date.now() });
    return state;
  })();
  parentActivationInFlightByUid.set(uid, task);
  try {
    return await task;
  } finally {
    parentActivationInFlightByUid.delete(uid);
  }
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
