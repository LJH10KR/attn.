"use client";

import { useEffect, useRef } from "react";

/**
 * 주소에 `?{name}={value}`가 있으면 한 번만 `onMatch`를 부르고 그 쿼리를 주소에서 지운다(뒤로가기·새로고침에 다시 열리지 않게).
 * 2-M 홈 "시작하기" 단계 버튼이 다른 화면의 시트를 바로 여는 데 쓴다(`?bulk=1`·`?new=1`·`?invite=qr`).
 * `enabled`가 참이 될 때까지(권한·데이터 준비) 기다린다.
 */
export function useQueryFlag(name: string, value: string, enabled: boolean, onMatch: () => void): void {
  const handled = useRef(false);
  const onMatchRef = useRef(onMatch);
  onMatchRef.current = onMatch;
  useEffect(() => {
    if (handled.current || !enabled) return;
    handled.current = true;
    const params = new URLSearchParams(window.location.search);
    if (params.get(name) !== value) return;
    params.delete(name);
    const q = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${q ? `?${q}` : ""}`);
    onMatchRef.current();
  }, [name, value, enabled]);
}
