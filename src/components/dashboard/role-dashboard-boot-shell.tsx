import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";

type RoleDashboardBootShellProps = {
  /** 스크린 리더용 안내 문구 */
  loadingLabel?: string;
  /** 시각적으로 아주 옅게 보이는 본문 한 줄(기본 문구) */
  footerHint?: string;
};

/**
 * 선생님·학부모 대시보드에서 활성 판별·초기 토큰 준비 전 구간용 셸.
 * 실제 `DashboardRoleHeader`와 유사한 상단 영역만 얇은 스켈레톤으로 채웁니다.
 */
export function RoleDashboardBootShell({
  loadingLabel = "대시보드 불러오는 중",
  footerHint = "계정과 연결 정보를 불러오는 중입니다.",
}: RoleDashboardBootShellProps) {
  return (
    <div className="min-h-[100dvh] bg-background px-4 pb-28">
      <p className="sr-only">{loadingLabel}</p>
      <div className="mx-auto max-w-lg pt-[max(0.85rem,env(safe-area-inset-top))]">
        <div
          className="animate-pulse rounded-2xl border border-neutral-200/60 bg-white/45 p-3 shadow-sm backdrop-blur-sm dark:border-white/10 dark:bg-white/8"
          aria-hidden
        >
          <div className="flex min-h-10 items-center justify-between gap-2">
            <div className="h-8 w-8 shrink-0 rounded-full bg-neutral-200/85 dark:bg-neutral-700/55" />
            <div className="mx-auto h-3.5 min-w-0 flex-1 max-w-[11rem] rounded-md bg-neutral-200/80 dark:bg-neutral-700/50" />
            <div className="h-8 w-8 shrink-0 rounded-full bg-neutral-200/75 dark:bg-neutral-700/48" />
          </div>
          <div className="mt-2.5 h-2.5 w-32 rounded-md bg-neutral-200/65 dark:bg-neutral-700/42" />
        </div>
        <p
          className="mt-6 text-center text-[11px] leading-relaxed text-neutral-400/75 dark:text-neutral-500/65"
          aria-hidden
        >
          {footerHint}
        </p>
      </div>
      <DashboardBottomScrim />
    </div>
  );
}
