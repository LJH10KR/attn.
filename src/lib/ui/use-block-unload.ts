"use client";

import { useEffect } from "react";

/** 서버가 되돌릴 수 없는 일을 하는 동안(탈퇴·학원 삭제, 2-N) 창 닫기·새로 고침 전에 브라우저 확인 창을 띄운다 */
export function useBlockUnloadWhile(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active]);
}
