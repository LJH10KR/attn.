"use client";

import { useCallback, useMemo, useState } from "react";
import { getPublicAppOrigin } from "@/lib/firebase/config";

export function AcademyParentSignupLink({ academyId }: { academyId: string }) {
  const [copied, setCopied] = useState(false);

  const signupUrl = useMemo(() => {
    const path = `/join/parent?academyId=${encodeURIComponent(academyId)}`;
    const origin = getPublicAppOrigin();
    return origin ? `${origin}${path}` : path;
  }, [academyId]);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(signupUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [signupUrl]);

  return (
    <div className="glass-card flex items-center justify-between gap-4 px-4 py-3">
      <p className="text-sm font-semibold text-foreground">학부모 회원 가입 링크</p>
      <button
        type="button"
        onClick={() => void onCopy()}
        className="shrink-0 rounded-[15px] bg-[#222] px-3 py-2 text-xs font-medium text-white dark:bg-neutral-100 dark:text-neutral-950"
      >
        {copied ? "복사됨" : "링크 복사"}
      </button>
    </div>
  );
}
