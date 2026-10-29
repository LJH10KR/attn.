"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useRoleLogout } from "@/lib/auth/use-role-logout";

export default function TeacherSessionPage() {
  const searchParams = useSearchParams();
  const { logout: onLogout, logoutBusy, logoutModal } = useRoleLogout({
    redirectTo: "/login/teacher",
    role: "teacher",
  });

  const state = searchParams.get("state") ?? "";
  const academyId = searchParams.get("academyId") ?? "";

  const message = useMemo(() => {
    switch (state) {
      case "pending_registration":
        return "가입 신청이 접수되었습니다. 학원에서 승인하면 바로 이용할 수 있습니다.";
      case "inactive":
        return "현재 계정은 비활성 상태입니다. 학원에 문의해 주세요.";
      default:
        return "현재 상태에서는 로그인할 수 없습니다. 학원 승인 절차가 완료된 뒤 다시 시도해 주세요.";
    }
  }, [state]);

  return (
    <div className="min-h-[100dvh] bg-background px-4 py-10 flex flex-col items-center justify-center">
      <div className="glass-card-hero w-full max-w-[520px] p-8">
        <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">
          {state === "pending_registration" ? "승인 대기 중" : "로그인 제한"}
        </h1>
        <p className="mt-4 text-center text-sm text-neutral-700">{message}</p>
        {academyId ? <p className="mt-2 text-center text-[11px] text-neutral-500">학원 ID: {academyId}</p> : null}
        <button
          type="button"
          onClick={() => void onLogout()}
          disabled={logoutBusy}
          className="mt-6 w-full rounded-2xl bg-[#222] dark:bg-neutral-100 py-3 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-60"
        >
          {logoutBusy ? "처리 중…" : "로그아웃하고 로그인 화면으로"}
        </button>
      </div>
      {logoutModal}
    </div>
  );
}
