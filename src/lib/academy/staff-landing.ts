"use client";

import { FirebaseError } from "firebase/app";
import { signOut, type User } from "firebase/auth";
import { doc, getDoc, type DocumentData } from "firebase/firestore";
import { academyPath, visibleAcademyTabs } from "@/lib/academy/academy-routes";
import { normalizePermissionList } from "@/lib/academy/permissions";
import { activationPathFromState } from "@/lib/firebase/activation-path";
import { COLLECTIONS } from "@/lib/firebase/attn-schema";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client-app";

/**
 * 직원 착지 — 로그인·첫 로그인 완료·앱 재실행·`/`·`/academy`·학원 레이아웃이 모두 이 판단을 쓴다.
 * 권한은 클레임에 없으므로 본인 staff 문서(`permissions`, 역할을 바꾸면 즉시 반영)로 본다.
 */

/** 계정 자체가 더 쓸 수 없게 된 토큰 갱신 오류(비활성·삭제·비밀번호 초기화 등) */
const ACCOUNT_AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  "auth/user-disabled",
  "auth/user-token-expired",
  "auth/user-not-found",
  "auth/invalid-user-token",
]);

/**
 * 토큰 갱신 실패가 계정 문제인지 — 이때만 로그아웃한다.
 * 네트워크 오류(`auth/network-request-failed`) 등은 계정이 멀쩡할 수 있으니 로그아웃하지 않는다.
 */
export function isAccountAuthError(err: unknown): boolean {
  return err instanceof FirebaseError && ACCOUNT_AUTH_ERROR_CODES.has(err.code);
}

/** 연결 문제로 보는 Firestore·Auth 오류 코드 */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "unavailable",
  "deadline-exceeded",
  "auth/network-request-failed",
]);

/**
 * catch한 오류가 연결 문제인지 — 오류 코드로 보고, 오류가 났을 때 기기가 오프라인이면(보조 판단) 연결 문제로 본다.
 * 오류가 없을 때 `navigator.onLine`만으로 판단하지 않는다.
 */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof FirebaseError && NETWORK_ERROR_CODES.has(err.code)) return true;
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** 활성 직원이고 볼 수 있는 학원 메뉴가 하나라도 있는지(`visibleAcademyTabs` 기준) */
export function staffDocHasAcademyMenus(data: DocumentData | null | undefined): boolean {
  if (!data || data.status !== "active") return false;
  const granted = new Set(normalizePermissionList(data.permissions));
  return visibleAcademyTabs((required) => required.some((p) => granted.has(p))).length > 0;
}

/**
 * 본인 staff 문서로 갈 곳 — 메뉴 있는 활성 직원은 학원 5탭, 메뉴 없으면 선생님 화면,
 * 활성이 아니면 상태별 안내(첫 로그인·승인 대기 등). 문서가 없으면 null.
 */
export function staffLandingFromDoc(academyId: string, data: DocumentData | null): string | null {
  if (!data) return null;
  if (data.status === "active") {
    return staffDocHasAcademyMenus(data) ? academyPath(academyId) : "/teacher";
  }
  return activationPathFromState("teacher", {
    anyActive: false,
    primaryStatus: typeof data.status === "string" ? data.status : null,
    primaryAcademyId: academyId,
  });
}

export type StaffLandingResult = { kind: "go"; target: string } | { kind: "offline" };

/**
 * 직원 착지 — 본인 staff 문서 한 번 읽기.
 * - 연결 문제로 읽지 못하면 `offline` — 판단할 수 없으니 `/teacher`로 보내지 않는다(호출 측이 연결 확인 화면).
 * - 그 밖의 이유로 읽지 못하면(문서가 없으면 규칙이 permission-denied) 예전처럼 `/teacher` —
 *   이 읽기 때문에 로그인·복원이 실패하지 않게 한다(선생님 화면이 스스로 상태를 다시 확인함).
 * - 문서가 활성이 아니면 클레임의 옛 "active"를 믿지 않도록 토큰을 새로 받는다 —
 *   비활성·삭제·비밀번호 초기화된 계정은 여기서 갱신이 실패하므로 로그아웃 후 로그인 화면.
 *   갱신이 네트워크 등 다른 이유로 실패하면 로그아웃하지 않고 문서로 판단한 곳으로 보낸다.
 */
export async function resolveStaffLandingResult(user: User, academyId: string): Promise<StaffLandingResult> {
  let data: DocumentData | null;
  try {
    const snap = await getDoc(doc(getFirebaseDb(), COLLECTIONS.academies, academyId, "staff", user.uid));
    data = snap.exists() ? snap.data() : null;
  } catch (err) {
    return isNetworkError(err) ? { kind: "offline" } : { kind: "go", target: "/teacher" };
  }
  const target = staffLandingFromDoc(academyId, data);
  if (!target) return { kind: "go", target: "/teacher" };
  if (data?.status !== "active") {
    try {
      await user.getIdToken(true);
    } catch (err) {
      if (!isAccountAuthError(err)) return { kind: "go", target };
      await signOut(getFirebaseAuth()).catch(() => undefined);
      return { kind: "go", target: "/login/teacher" };
    }
  }
  return { kind: "go", target };
}

/**
 * 갈 주소만 필요한 곳(로그인·세션 복원·첫 로그인·`/academy` 진입) — 연결 문제면 그 학원 주소로 보내
 * 학원 레이아웃의 "연결을 확인해 주세요 + 다시 시도" 화면이 받게 한다(다시 시도하면 레이아웃이 다시 판단:
 * 메뉴 없는 직원은 `/teacher`, 활성이 아니면 안내 화면).
 */
export async function resolveStaffLanding(user: User, academyId: string): Promise<string> {
  const result = await resolveStaffLandingResult(user, academyId);
  return result.kind === "go" ? result.target : academyPath(academyId);
}
