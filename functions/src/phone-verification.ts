import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { assertFreshAppCheck, ONE_SHOT_APP_CHECK_OPTIONS, SIGNUP_APP_CHECK_OPTIONS } from "./lib/app-check";
import { maskPhoneKey, octomoMessageExists } from "./lib/octomo";
import {
  counterKeys,
  counterTtl,
  decideCheckGate,
  isPhoneVerificationPurpose,
  isVerificationId,
  issueLimitsOk,
  ISSUABLE_PURPOSES,
  newPhoneCode,
  newPhoneProof,
  newVerificationId,
  octomoBudgetAvailable,
  octomoPhoneKey,
  phoneCounterRef,
  phoneVerificationRef,
  readCount,
  seoulDayEndMs,
  shortHash,
  withinMinutesFor,
  type PhoneVerificationPurpose,
  type PhoneVerificationScope,
} from "./lib/phone-verification";
import {
  OCTOMO_INBOUND_NUMBER,
  PHONE_CHECKS_PER_CODE,
  PHONE_CODE_TTL_MS,
  PHONE_PROOF_TTL_MS,
  PHONE_VERIFICATION_DOC_TTL_MS,
} from "./lib/phone-verification-limits";
import { hashSignupToken, parseSignupToken, resolveSignupLink } from "./lib/signup-links";

/**
 * 휴대폰 번호 확인(OCTOMO MO 방식, 2-L) — 코드 발급(`startPhoneVerification`)·조회(`checkPhoneVerification`).
 * 결과가 정상적인 경우(한도·문자 없음·만료 등)는 오류가 아니라 `status`로 돌려준다 — 화면은 건너뛰기·다시 시도를 안내.
 * OCTOMO 키는 조회 함수만 Secret Manager(`OCTOMO_API_KEY`)로 받는다. 에뮬레이터는 항상 가짜 모드(`lib/octomo.ts`).
 */

const OCTOMO_API_KEY = defineSecret("OCTOMO_API_KEY");

function clientIp(request: CallableRequest): string | null {
  const fwd = request.rawRequest?.headers?.["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  const ip = first || request.rawRequest?.ip || "";
  return ip ? ip : null;
}

/** 번호 변경 — 로그인한 학부모·직원 본인(클레임) */
function accountScopeFromAuth(request: CallableRequest): PhoneVerificationScope {
  const auth = request.auth;
  if (!auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const role = auth.token.role;
  const academyId = typeof auth.token.academyId === "string" ? auth.token.academyId : "";
  if ((role !== "parent" && role !== "teacher") || !academyId) {
    throw new HttpsError("permission-denied", "학부모·직원 계정만 번호를 바꿀 수 있습니다.");
  }
  return { kind: "account", uid: auth.uid, academyId, role };
}

type StartResult =
  | { status: "issued"; verificationId: string; code: string; smsTo: string; expiresAtMs: number }
  | { status: "unsupported_phone" }
  | { status: "unavailable" };

/**
 * 코드 발급 — 가입(`parent_signup`·`staff_signup`)은 가입 QR 토큰, 번호 변경(`phone_change`)은 로그인 본인.
 * OCTOMO는 부르지 않는다(조회는 사용자가 [문자를 보냈어요]를 누를 때만). 오늘 OCTOMO 한도가 이미 찼거나
 * 번호·IP·계정별 발급 제한을 넘으면 `unavailable`(가입 화면은 "번호 확인 없이 계속").
 */
export const startPhoneVerification = onCall(SIGNUP_APP_CHECK_OPTIONS, async (request): Promise<StartResult> => {
  const purpose = request.data?.purpose;
  if (!isPhoneVerificationPurpose(purpose) || !ISSUABLE_PURPOSES.includes(purpose)) {
    throw new HttpsError("invalid-argument", "확인 목적이 올바르지 않습니다.");
  }
  const db = admin.firestore();
  let scope: PhoneVerificationScope;
  if (purpose === "phone_change") {
    scope = accountScopeFromAuth(request);
  } else {
    const kind = purpose === "parent_signup" ? "parent" : "staff";
    await resolveSignupLink(db, request.data?.token, kind);
    scope = { kind: "signup_link", linkHash: hashSignupToken(parseSignupToken(request.data?.token)!) };
  }

  const phoneKey = octomoPhoneKey(request.data?.phone);
  if (!phoneKey) return { status: "unsupported_phone" };

  const nowMs = Date.now();
  const ip = clientIp(request);
  const keys = counterKeys({
    nowMs,
    phoneKey,
    ipHash: ip ? shortHash(ip) : null,
    uid: scope.kind === "account" ? scope.uid : null,
    linkHash: scope.kind === "signup_link" ? scope.linkHash : null,
  });

  const outcome = await db.runTransaction(async (tx) => {
    const issueKeys = [keys.phoneHour, keys.phoneDay, keys.ipHour, keys.uidHour];
    const [octomoDay, linkDay, ...issueSnaps] = await Promise.all([
      tx.get(phoneCounterRef(db, keys.octomoDay)),
      keys.linkDay ? tx.get(phoneCounterRef(db, keys.linkDay)) : Promise.resolve(null),
      ...issueKeys.map((k) => (k ? tx.get(phoneCounterRef(db, k)) : Promise.resolve(null))),
    ]);
    const blocked = octomoDay.get("blockedUntil");
    const budgetOk = octomoBudgetAvailable({
      globalCount: readCount(octomoDay.get("count")),
      globalBlockedUntilMs: blocked instanceof Timestamp ? blocked.toMillis() : null,
      linkCount: linkDay ? readCount(linkDay.get("count")) : null,
      nowMs,
    });
    const [phoneHour, phoneDay, ipHour, uidHour] = issueSnaps.map((s) => (s ? readCount(s.get("count")) : null));
    const limitsOk = issueLimitsOk({ phoneHour: phoneHour ?? 0, phoneDay: phoneDay ?? 0, ipHour, uidHour });
    if (!budgetOk || !limitsOk) return null;

    issueKeys.forEach((k, i) => {
      if (!k) return;
      tx.set(
        phoneCounterRef(db, k),
        { count: (issueSnaps[i] ? readCount(issueSnaps[i]!.get("count")) : 0) + 1, ttlAt: counterTtl(nowMs) },
        { merge: true },
      );
    });
    const verificationId = newVerificationId();
    const code = newPhoneCode();
    const expiresAtMs = nowMs + PHONE_CODE_TTL_MS;
    tx.create(phoneVerificationRef(db, verificationId), {
      purpose,
      phoneKey,
      code,
      scope: scope.kind === "signup_link"
        ? { linkHash: scope.linkHash }
        : { uid: scope.uid, academyId: scope.academyId, role: scope.role },
      status: "pending",
      checkCount: 0,
      lastCheckAt: null,
      createdAt: Timestamp.fromMillis(nowMs),
      expiresAt: Timestamp.fromMillis(expiresAtMs),
      ttlAt: Timestamp.fromMillis(nowMs + PHONE_VERIFICATION_DOC_TTL_MS),
    });
    return { verificationId, code, expiresAtMs };
  });

  if (!outcome) {
    logger.info("startPhoneVerification: 한도로 발급 안 함", { purpose, phone: maskPhoneKey(phoneKey) });
    return { status: "unavailable" };
  }
  return { status: "issued", ...outcome, smsTo: OCTOMO_INBOUND_NUMBER };
});

type CheckResult =
  | { status: "verified"; proof: string; proofExpiresAtMs: number }
  | { status: "not_found"; remaining: number }
  | { status: "too_soon"; retryAfterMs: number }
  | { status: "expired" | "exhausted" | "unavailable" };

/**
 * 조회 — 사용자가 [문자를 보냈어요]를 누를 때만. 코드당 3회·5초 간격, 서비스 전체 하루 한도·링크별 하루 한도.
 * 트랜잭션에서 판단·카운터를 올린 뒤 OCTOMO를 1회 부른다(호출은 결과와 상관없이 1건으로 셈).
 * 문자가 있으면 코드를 소비하고 증표를 준다. 429면 그날 끝까지 OCTOMO를 부르지 않는다.
 * App Check 1회용 토큰(누를 때마다 새 토큰).
 */
export const checkPhoneVerification = onCall(
  { ...ONE_SHOT_APP_CHECK_OPTIONS, secrets: [OCTOMO_API_KEY] },
  async (request): Promise<CheckResult> => {
    assertFreshAppCheck(request);
    const verificationId = request.data?.verificationId;
    if (!isVerificationId(verificationId)) {
      throw new HttpsError("invalid-argument", "확인 요청이 올바르지 않습니다.");
    }
    const db = admin.firestore();
    const ref = phoneVerificationRef(db, verificationId);
    const nowMs = Date.now();

    const gate = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: "missing" as const };
      const scope = (snap.get("scope") ?? {}) as Record<string, unknown>;
      const purpose = snap.get("purpose") as PhoneVerificationPurpose;
      if (purpose === "phone_change" && scope.uid !== request.auth?.uid) return { kind: "missing" as const };
      const createdAtMs = (snap.get("createdAt") as Timestamp | undefined)?.toMillis() ?? nowMs;
      const checkCount = readCount(snap.get("checkCount"));
      const decision = decideCheckGate({
        status: snap.get("status"),
        expiresAtMs: (snap.get("expiresAt") as Timestamp | undefined)?.toMillis() ?? 0,
        checkCount,
        lastCheckAtMs: (snap.get("lastCheckAt") as Timestamp | null | undefined)?.toMillis() ?? null,
        nowMs,
      });
      if (!decision.ok) return { kind: "gate" as const, decision };

      const linkHash = typeof scope.linkHash === "string" ? scope.linkHash : null;
      const keys = counterKeys({ nowMs, phoneKey: "", ipHash: null, uid: null, linkHash });
      const [octomoDay, linkDay] = await Promise.all([
        tx.get(phoneCounterRef(db, keys.octomoDay)),
        keys.linkDay ? tx.get(phoneCounterRef(db, keys.linkDay)) : Promise.resolve(null),
      ]);
      const blocked = octomoDay.get("blockedUntil");
      const budgetOk = octomoBudgetAvailable({
        globalCount: readCount(octomoDay.get("count")),
        globalBlockedUntilMs: blocked instanceof Timestamp ? blocked.toMillis() : null,
        linkCount: linkDay ? readCount(linkDay.get("count")) : null,
        nowMs,
      });
      if (!budgetOk) return { kind: "unavailable" as const };

      tx.set(
        phoneCounterRef(db, keys.octomoDay),
        { count: readCount(octomoDay.get("count")) + 1, ttlAt: counterTtl(nowMs) },
        { merge: true },
      );
      if (keys.linkDay && linkDay) {
        tx.set(
          phoneCounterRef(db, keys.linkDay),
          { count: readCount(linkDay.get("count")) + 1, ttlAt: counterTtl(nowMs) },
          { merge: true },
        );
      }
      tx.update(ref, { checkCount: checkCount + 1, lastCheckAt: Timestamp.fromMillis(nowMs) });
      return {
        kind: "call" as const,
        phoneKey: snap.get("phoneKey") as string,
        code: snap.get("code") as string,
        createdAtMs,
        checksAfter: checkCount + 1,
        octomoDayKey: keys.octomoDay,
      };
    });

    if (gate.kind === "missing") {
      throw new HttpsError("not-found", "확인 요청을 찾을 수 없습니다. 처음부터 다시 해 주세요.");
    }
    if (gate.kind === "unavailable") return { status: "unavailable" };
    if (gate.kind === "gate") {
      const d = gate.decision;
      if (d.status === "too_soon") return { status: "too_soon", retryAfterMs: d.retryAfterMs };
      // 이미 확인된 코드를 다시 누름 — 증표는 한 번만 준다
      return { status: d.status === "already_verified" ? "exhausted" : d.status };
    }

    const result = await octomoMessageExists({
      apiKey: process.env.FUNCTIONS_EMULATOR === "true" ? "" : OCTOMO_API_KEY.value(),
      phoneKey: gate.phoneKey,
      text: gate.code,
      withinMinutes: withinMinutesFor(gate.createdAtMs, nowMs),
    });

    if (result === "rate_limited") {
      await phoneCounterRef(db, gate.octomoDayKey)
        .set({ blockedUntil: Timestamp.fromMillis(seoulDayEndMs(nowMs)), ttlAt: counterTtl(nowMs) }, { merge: true })
        .catch((e) => logger.warn("checkPhoneVerification: 429 차단 기록 실패", { e }));
      return { status: "unavailable" };
    }
    if (result === "error") return { status: "unavailable" };

    if (result === "not_found") {
      const remaining = Math.max(0, PHONE_CHECKS_PER_CODE - gate.checksAfter);
      if (remaining === 0) {
        await ref.update({ status: "exhausted" }).catch(() => undefined);
        return { status: "exhausted" };
      }
      return { status: "not_found", remaining };
    }

    // 문자 확인됨 — 코드 소비·증표(트랜잭션: 같은 코드의 동시 조회가 증표를 두 번 받지 않게)
    const { proof, proofHash } = newPhoneProof(verificationId);
    const proofExpiresAtMs = Date.now() + PHONE_PROOF_TTL_MS;
    const issued = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.get("status") !== "pending") return false;
      tx.update(ref, {
        status: "verified",
        verifiedAt: FieldValue.serverTimestamp(),
        proofHash,
        proofExpiresAt: Timestamp.fromMillis(proofExpiresAtMs),
        usedAt: null,
      });
      return true;
    });
    if (!issued) return { status: "exhausted" };
    return { status: "verified", proof, proofExpiresAtMs };
  },
);
