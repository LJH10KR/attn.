const cache = new Map<string, { data: unknown; expiresAt: number }>();

/** 표시 전용(쓰기 직후 즉시 반영이 필요 없는) 조회에만 사용 — CUD 직후 refresh()가 필요한 곳엔 쓰지 않음 */
export async function cachedRead<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs = 60_000,
): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data as T;
  const data = await fetcher();
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  return data;
}
