/**
 * `retry: true` Firestore 트리거 공용 — 일시 오류(다시 하면 될 수 있음)만 다시 던져 재시도하고,
 * 그 밖의 오류와 오래된 이벤트는 로그만 남기고 끝낸다(무한 재시도 방지).
 * 트리거 작업은 모두 "현재 값에 맞추기"라 같은 이벤트가 여러 번 와도 결과가 같아야 한다.
 */

const RETRIABLE_CODES = new Set<unknown>([
  4, 8, 10, 13, 14,
  "deadline-exceeded", "resource-exhausted", "aborted", "internal", "unavailable",
]);

/** 이보다 오래된 이벤트(재시도가 계속 실패한 경우)는 처리하지 않는다 */
export const MAX_TRIGGER_RETRY_AGE_MS = 24 * 60 * 60 * 1000;

export function isRetriableError(e: unknown): boolean {
  return RETRIABLE_CODES.has((e as { code?: unknown } | null)?.code);
}

export function triggerEventAgeMs(eventTime: string): number {
  return Date.now() - Date.parse(eventTime);
}
