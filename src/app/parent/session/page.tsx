"use client";

import { signOut } from "firebase/auth";
import { useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getFirebaseAuth } from "@/lib/firebase/client-app";
import { tearDownParentWebPushForLogout } from "@/lib/firebase/web-push";

export default function ParentSessionPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [busy, setBusy] = useState(false);

  const state = searchParams.get("state") ?? "";
  const academyId = searchParams.get("academyId") ?? "";

  const message = useMemo(() => {
    switch (state) {
      case "pending_registration":
        return "현재 학부모 등록 대기(pending) 상태라 로그인할 수 없습니다. 학원에서 활성 처리 후 다시 시도해 주세요.";
      case "invitation_sent":
        return "현재 학부모는 초청 진행 단계입니다. 이메일 인증과 등록 완료 처리를 먼저 진행해 주세요.";
      case "inactive":
        return "현재 학부모 계정은 비활성 상태입니다. 학원에 문의해 주세요.";
      case "invitation_needed":
        return "현재 상태에서는 로그인할 수 없습니다. 학원에서 초청을 다시 진행해 주세요.";
      default:
        return "현재 상태에서는 로그인할 수 없습니다. 학원 승인 절차가 완료된 뒤 다시 시도해 주세요.";
    }
  }, [state]);

  const onLogout = useCallback(async () => {
    setBusy(true);
    try {
      await tearDownParentWebPushForLogout();
      await signOut(getFirebaseAuth());
    } finally {
      setBusy(false);
      router.replace("/login/parent");
    }
  }, [router]);

  return (
    <div className="min-h-[100dvh] bg-background px-4 py-10 flex flex-col items-center justify-center">
      <div className="glass-card-hero w-full max-w-[520px] p-8">
        <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">로그인 제한</h1>
        <p className="mt-4 text-center text-sm text-neutral-700">{message}</p>
        {academyId ? <p className="mt-2 text-center text-[11px] text-neutral-500">학원 ID: {academyId}</p> : null}
        <button
          type="button"
          onClick={() => void onLogout()}
          disabled={busy}
          className="mt-6 w-full rounded-2xl bg-[#222] dark:bg-neutral-100 py-3 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-60"
        >
          {busy ? "처리 중…" : "로그아웃하고 로그인 화면으로"}
        </button>
      </div>
    </div>
  );
}
