"use client";

import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

/** `backdrop-filter` 조상 안에서 `fixed`가 뷰포트가 아닌 박스에 묶이는 문제 방지 */
export function ModalPortal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;
  return createPortal(children, document.body);
}
