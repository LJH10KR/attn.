"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { WITHDRAWAL_TEXT as T, WITHDRAWN_ROLE_STORAGE_KEY } from "@/lib/auth/account-withdrawal-text";
import { clearLastDashboardRoleHint } from "@/lib/auth/last-dashboard-role";
import { performLogout, type LogoutRole } from "@/lib/auth/perform-logout";
import { isFirebaseConfigured } from "@/lib/firebase/config";

/**
 * 회원 탈퇴 완료(2-N) — 공개 화면(로그인 없이). 탈퇴한 기기의 로컬 로그인·알림 배지·푸시를 여기서 정리한다
 * (서버는 이미 Auth를 지움 — 설정 화면에서 바로 로그아웃하면 그 화면이 로그인 화면으로 먼저 보내서).
 */
export default function WithdrawnPage() {
  const [cleaning, setCleaning] = useState(true);

  useEffect(() => {
    let role: LogoutRole = "generic";
    try {
      const r = sessionStorage.getItem(WITHDRAWN_ROLE_STORAGE_KEY);
      if (r === "parent" || r === "teacher" || r === "owner") role = r;
      sessionStorage.removeItem(WITHDRAWN_ROLE_STORAGE_KEY);
    } catch {
      /* 무시 */
    }
    clearLastDashboardRoleHint();
    if (!isFirebaseConfigured()) {
      setCleaning(false);
      return;
    }
    // 서버는 이미 정리됨 — 이 기기만(FCM 토큰·로컬 저장·배지·signOut). 서버 푸시 끄기를 부르면 users 문서가 다시 생김
    void performLogout({ role, localOnly: true })
      .catch(() => undefined)
      .finally(() => setCleaning(false));
  }, []);

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10">
      <div className="glass-card w-full max-w-md space-y-4 p-8 text-center" data-testid="withdrawn-page">
        <p className="text-xs text-neutral-500">attn.</p>
        <h1 className="text-lg font-semibold text-foreground">{T.doneTitle}</h1>
        <p className="break-keep text-sm text-neutral-600">{T.doneBody}</p>
        <Link
          href="/"
          aria-disabled={cleaning}
          className={`block w-full rounded-2xl bg-[#222] py-3 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950 ${cleaning ? "pointer-events-none opacity-50" : ""}`}
        >
          {T.doneHome}
        </Link>
      </div>
    </main>
  );
}
