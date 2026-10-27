import type * as admin from "firebase-admin";
import { FieldValue, Timestamp, type DocumentReference } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { simulatePasswordCheck, verifyLoginSecret } from "./password-hash";

/**
 * 로그인 ID 로그인(선생님·학부모) 연속 실패 제한 — 계정별로 `secrets/login` 문서에 기록(클라이언트 접근 불가).
 * 시도 횟수는 비밀번호 검증 **전에** 트랜잭션으로 올린다(동시 요청으로 한도를 넘겨 대입하지 못하게).
 * 성공하면 0으로 초기화하므로 값은 "마지막 성공 뒤 연속 시도 수"다.
 * 연속 실패가 한도를 넘으면(한도+1번째 시도) 일정 시간 잠그고, 잠금 중에는 맞는 비밀번호도 거부한다.
 * 판단은 Firestore 없는 순수 함수(`test/login-throttle.test.mjs`).
 */

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

export type LoginThrottleState = {
  failures: number;
  lockedUntilMillis: number | null;
};

export type LoginAttemptDecision =
  /** next: 저장할 상태 */
  | { allowed: true; next: LoginThrottleState }
  /** next: 저장할 상태(이미 잠겨 있으면 null — 쓰지 않음) */
  | { allowed: false; next: LoginThrottleState | null; retryAfterMs: number };

export function beginLoginAttempt(prev: LoginThrottleState, now: number): LoginAttemptDecision {
  if (prev.lockedUntilMillis !== null && prev.lockedUntilMillis > now) {
    return { allowed: false, next: null, retryAfterMs: prev.lockedUntilMillis - now };
  }
  // 잠금이 풀렸으면 처음부터
  const failures = prev.lockedUntilMillis !== null ? 0 : prev.failures;
  if (failures >= LOGIN_MAX_FAILURES) {
    return {
      allowed: false,
      next: { failures: 0, lockedUntilMillis: now + LOGIN_LOCK_MS },
      retryAfterMs: LOGIN_LOCK_MS,
    };
  }
  return { allowed: true, next: { failures: failures + 1, lockedUntilMillis: null } };
}

export function lockedLoginMessage(retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60000));
  return `로그인에 여러 번 실패해 잠시 잠겼습니다. ${minutes}분 뒤에 다시 시도해 주세요.`;
}

/** `secrets/login` 문서 데이터에서 읽기 — 형식이 깨졌으면 기록 없음으로 */
export function readLoginThrottle(
  secret: FirebaseFirestore.DocumentData | undefined,
): LoginThrottleState {
  const failures = secret?.loginFailures;
  const lockedUntil = secret?.loginLockedUntil;
  return {
    failures:
      typeof failures === "number" && Number.isInteger(failures) && failures > 0 ? failures : 0,
    lockedUntilMillis: lockedUntil instanceof Timestamp ? lockedUntil.toMillis() : null,
  };
}

/** `update`/`set(merge)`용 필드 */
export function loginThrottleFields(state: LoginThrottleState) {
  return {
    loginFailures: state.failures,
    loginLockedUntil:
      state.lockedUntilMillis === null
        ? FieldValue.delete()
        : Timestamp.fromMillis(state.lockedUntilMillis),
  };
}

/** 로그인 성공·관리자 비밀번호 초기화 시 */
export const LOGIN_THROTTLE_RESET: LoginThrottleState = { failures: 0, lockedUntilMillis: null };

/**
 * `secrets/login` 비밀번호 확인 — 로그인·본인 재확인·비밀번호 변경 전 확인이 모두 이 함수를 거쳐 같은 잠금을 공유한다.
 * 비밀번호가 없거나(Google 전용) 틀리면 같은 `permission-denied`(wrongMessage), 잠금 중이면 `resource-exhausted`.
 */
export async function verifyLoginPasswordThrottled(
  db: admin.firestore.Firestore,
  secretRef: DocumentReference,
  password: string,
  wrongMessage: string,
): Promise<void> {
  const attempt = await db.runTransaction(async (tx) => {
    const snap = await tx.get(secretRef);
    if (!snap.exists) return null;
    const decision = beginLoginAttempt(readLoginThrottle(snap.data()), Date.now());
    if (decision.next) {
      tx.update(secretRef, loginThrottleFields(decision.next));
    }
    return { secret: snap.data(), decision };
  });
  if (!attempt) {
    await simulatePasswordCheck(password);
    throw new HttpsError("permission-denied", wrongMessage);
  }
  if (!attempt.decision.allowed) {
    throw new HttpsError("resource-exhausted", lockedLoginMessage(attempt.decision.retryAfterMs));
  }
  if (!(await verifyLoginSecret(attempt.secret, password))) {
    throw new HttpsError("permission-denied", wrongMessage);
  }
  await secretRef.update(loginThrottleFields(LOGIN_THROTTLE_RESET));
}
