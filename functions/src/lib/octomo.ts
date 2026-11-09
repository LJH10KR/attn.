import * as logger from "firebase-functions/logger";
import { OCTOMO_REQUEST_TIMEOUT_MS } from "./phone-verification-limits";

/**
 * OCTOMO(주식회사 옥토버스) MO 방식 휴대폰 번호 확인 — 사용자가 1666-3538로 보낸 문자가 있는지 조회만 한다.
 * `POST https://api.octoverse.kr/octomo/v1/public/message/exists`, 헤더 `Authorization: Octomo {KEY}`,
 * body `mobileNum`(010 11자리)·`text`(완전 일치)·`withinMinutes`(1~60) → `{ exists }`.
 * 같은 문자는 여러 번 조회해도 true(1회용 아님, 사용자 시험 11-09) → 소비 처리는 우리 서버(`phone-verification.ts`)가 한다.
 * 키·전체 번호는 로그에 남기지 않는다.
 *
 * 가짜 모드: Functions 에뮬레이터(`FUNCTIONS_EMULATOR === "true"`)에서는 항상 가짜(실제 OCTOMO를 부르지 않음, 키도 읽지 않음).
 * 환경 변수로 켜거나 끌 수 없다 — 운영에서 실수로 가짜가 되는 길을 두지 않는다.
 * 번호 끝 4자리로 결과를 정한다: `0000` 문자 없음 / `0429` 한도 초과(429) / `0500` 오류 / 그 밖 문자 있음.
 */

export const OCTOMO_EXISTS_URL = "https://api.octoverse.kr/octomo/v1/public/message/exists";

export type OctomoResult = "exists" | "not_found" | "rate_limited" | "error";

export function isOctomoFakeMode(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true";
}

/** 가짜 모드 결과 — 번호 끝 4자리 규칙 */
export function fakeOctomoResult(phoneKey: string): OctomoResult {
  const tail = phoneKey.slice(-4);
  if (tail === "0000") return "not_found";
  if (tail === "0429") return "rate_limited";
  if (tail === "0500") return "error";
  return "exists";
}

/** 로그용 — 끝 4자리만 */
export function maskPhoneKey(phoneKey: string): string {
  return phoneKey.length >= 4 ? `***${phoneKey.slice(-4)}` : "***";
}

export async function octomoMessageExists(params: {
  apiKey: string;
  phoneKey: string;
  text: string;
  withinMinutes: number;
}): Promise<OctomoResult> {
  if (isOctomoFakeMode()) {
    return fakeOctomoResult(params.phoneKey);
  }
  const apiKey = params.apiKey.trim();
  if (!apiKey) {
    logger.error("octomo: API 키가 없습니다(Secret OCTOMO_API_KEY)");
    return "error";
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OCTOMO_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(OCTOMO_EXISTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Octomo ${apiKey}` },
      body: JSON.stringify({
        mobileNum: params.phoneKey,
        text: params.text,
        withinMinutes: params.withinMinutes,
      }),
      signal: controller.signal,
    });
    if (res.status === 429) {
      logger.warn("octomo: 429 한도 초과", { phone: maskPhoneKey(params.phoneKey) });
      return "rate_limited";
    }
    if (!res.ok) {
      logger.error("octomo: 응답 오류", { status: res.status, phone: maskPhoneKey(params.phoneKey) });
      return "error";
    }
    const body = (await res.json().catch(() => null)) as { exists?: unknown } | null;
    if (!body || typeof body.exists !== "boolean") {
      logger.error("octomo: 응답 형식이 다름", { status: res.status });
      return "error";
    }
    return body.exists ? "exists" : "not_found";
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    logger.error("octomo: 요청 실패", { aborted, phone: maskPhoneKey(params.phoneKey) });
    return "error";
  } finally {
    clearTimeout(timer);
  }
}
