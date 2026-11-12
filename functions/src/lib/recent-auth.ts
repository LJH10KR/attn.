import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

/**
 * 최근 인증 확인(2-N ★1) — 탈퇴·원장 학원 삭제처럼 되돌릴 수 없는 작업은 본인 재확인 직후에만.
 * ID 토큰 `auth_time`(초)은 "로그인한 시각"이라, 화면은 재확인(비밀번호·Google·커스텀 토큰) 뒤
 * `getIdToken(true)`로 새 토큰을 받아 부른다(B3).
 */

export const RECENT_AUTH_MAX_AGE_MS = 5 * 60 * 1000;
/** 기기 시계 차이로 auth_time이 서버 시각보다 조금 앞설 수 있음 — 그 정도는 허용 */
const FUTURE_SKEW_MS = 60 * 1000;

export const MSG_REAUTH_REQUIRED = "본인 확인 시간이 지났어요. 다시 확인해 주세요.";

/** 순수 판단 — authTimeSec가 지금부터 maxAgeMs 안이면 참 */
export function isRecentAuth(authTimeSec: unknown, nowMs: number, maxAgeMs: number = RECENT_AUTH_MAX_AGE_MS): boolean {
  if (typeof authTimeSec !== "number" || !Number.isFinite(authTimeSec) || authTimeSec <= 0) return false;
  const authMs = authTimeSec * 1000;
  if (authMs > nowMs + FUTURE_SKEW_MS) return false;
  return nowMs - authMs <= maxAgeMs;
}

/**
 * 에뮬레이터 전용 시간 조정(B3) — `FUNCTIONS_EMULATOR`일 때만 `_emulatorTest/recentAuth.maxAgeMs`를 읽는다.
 * 운영에서는 읽지 않는다(환경 파일에도 넣지 않음). 스모크가 "최근 인증 아님"을 만들 때 1ms로 둔다.
 */
async function maxAgeMs(): Promise<number> {
  if (process.env.FUNCTIONS_EMULATOR !== "true") return RECENT_AUTH_MAX_AGE_MS;
  try {
    const v = (await admin.firestore().doc("_emulatorTest/recentAuth").get()).get("maxAgeMs");
    return typeof v === "number" && v > 0 ? v : RECENT_AUTH_MAX_AGE_MS;
  } catch {
    return RECENT_AUTH_MAX_AGE_MS;
  }
}

export async function assertRecentAuth(request: {
  auth?: { token?: { auth_time?: unknown } } | null;
}): Promise<void> {
  const ok = isRecentAuth(request.auth?.token?.auth_time, Date.now(), await maxAgeMs());
  if (!ok) {
    throw new HttpsError("failed-precondition", MSG_REAUTH_REQUIRED, { reason: "reauth_required" });
  }
}
