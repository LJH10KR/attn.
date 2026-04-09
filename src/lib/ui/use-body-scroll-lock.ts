"use client";

import { useEffect } from "react";

let lockCount = 0;
let savedHtmlOverflow = "";
let savedBodyOverflow = "";
let savedBodyTouchAction = "";

/**
 * 모달·시트 등 오버레이가 열릴 때 문서 배경 스크롤을 막습니다.
 * 중첩 시 참조 카운트로 한 번만 잠그고, 마지막이 닫힐 때만 복원합니다.
 */
export function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked || typeof document === "undefined") return;

    lockCount += 1;
    if (lockCount === 1) {
      const html = document.documentElement;
      const body = document.body;
      savedHtmlOverflow = html.style.overflow;
      savedBodyOverflow = body.style.overflow;
      savedBodyTouchAction = body.style.touchAction;
      html.style.overflow = "hidden";
      body.style.overflow = "hidden";
      body.style.touchAction = "none";
    }

    return () => {
      lockCount -= 1;
      if (lockCount < 0) lockCount = 0;
      if (lockCount === 0) {
        const html = document.documentElement;
        const body = document.body;
        html.style.overflow = savedHtmlOverflow;
        body.style.overflow = savedBodyOverflow;
        body.style.touchAction = savedBodyTouchAction;
      }
    };
  }, [locked]);
}
