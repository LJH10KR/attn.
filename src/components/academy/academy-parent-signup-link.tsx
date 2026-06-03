"use client";

import { useCallback, useMemo, useState } from "react";

export function AcademyParentSignupLink({ academyId }: { academyId: string }) {
  const [copied, setCopied] = useState(false);

  const signupUrl = useMemo(() => {
    if (typeof window === "undefined") {
      return `/join/parent?academyId=${encodeURIComponent(academyId)}`;
    }
    return `${window.location.origin}/join/parent?academyId=${encodeURIComponent(academyId)}`;
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
    <section className="glass-card space-y-3 p-4">
      <h3 className="text-sm font-semibold text-foreground">학부모 회원 가입 링크</h3>
      <p className="text-xs leading-relaxed text-neutral-600">
        학부모에게 아래 링크를 보내 가입하도록 안내하세요. 가입 시 이름·비밀번호를 직접 설정하며,
        로그인 번호(attnId)는 가입 완료 후 안내됩니다.
      </p>
      <p className="break-all rounded-xl bg-white/50 px-3 py-2 font-mono text-[11px] text-neutral-700 ring-1 ring-black/5 dark:bg-white/10">
        {signupUrl}
      </p>
      <button
        type="button"
        onClick={() => void onCopy()}
        className="w-full rounded-2xl bg-[#222] py-2.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950"
      >
        {copied ? "복사됨" : "링크 복사"}
      </button>
    </section>
  );
}
