"use client";

const TOP_OUTER_PT = "pt-[max(0.85rem,env(safe-area-inset-top))]";
const TOP_OUTER_PB = "pb-1";
/** 헤더 한 줄·스페이서 공통 높이(뒤로/제목/벨 정렬) */
const INNER_ROW =
  "flex min-h-10 items-center justify-between gap-2";

function BellIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3a6 6 0 00-6 6v2.4L4 14v1h16v-1l-2-2.6V9a6 6 0 00-6-6z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M9 19a3 3 0 006 0"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export type DashboardTopHeaderProps = {
  title: string;
  showBack?: boolean;
  onBack?: () => void;
  backAriaLabel?: string;
  backHint?: string;
  onBellClick?: () => void;
  /** false이면 알림 버튼을 숨깁니다. */
  showBell?: boolean;
};

/**
 * 대시보드 상단 고정 바: 제목·뒤로가기(선택)·알림(선택)만 배치합니다.
 * 배경 효과는 `DashboardTopScrim`에 두고, 여기서는 테두리·캡슐 글래스를 쓰지 않습니다.
 */
export function DashboardTopHeader({
  title,
  showBack = false,
  onBack,
  backAriaLabel = "뒤로 가기",
  backHint,
  onBellClick,
  showBell = true,
}: DashboardTopHeaderProps) {
  return (
    <header
      className={`fixed inset-x-0 top-0 z-30 ${TOP_OUTER_PT} ${TOP_OUTER_PB} pointer-events-none`}
      aria-label="대시보드 상단"
    >
      <div className="mx-auto max-w-lg px-4 pointer-events-auto">
        <div className={INNER_ROW}>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {showBack ? (
              <button
                type="button"
                onClick={onBack}
                aria-label={backAriaLabel}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-transparent text-foreground transition hover:bg-black/[0.05] dark:hover:bg-white/10"
              >
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M15 6l-6 6 6 6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : null}
            <h1 className="truncate text-[23px] font-bold leading-tight tracking-tight text-foreground">
              {title}
            </h1>
          </div>
          {showBell ? (
            <button
              type="button"
              onClick={() => onBellClick?.()}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-foreground transition hover:bg-black/[0.05] dark:hover:bg-white/10"
              aria-label="알림"
            >
              <BellIcon />
            </button>
          ) : null}
        </div>
        {showBack && backHint ? (
          <p className="mt-1 pl-11 text-xs text-neutral-500 dark:text-neutral-400">
            {backHint}
          </p>
        ) : null}
      </div>
    </header>
  );
}

/** 고정 헤더와 동일한 세로 공간을 확보해 본문이 헤더 아래에서 시작하도록 합니다. */
export function DashboardTopHeaderSpacer({
  showSubline,
}: {
  showSubline: boolean;
}) {
  return (
    <div
      aria-hidden
      className={`mx-auto max-w-lg px-4 ${TOP_OUTER_PT} ${TOP_OUTER_PB}`}
    >
      <div className={INNER_ROW} />
      {showSubline ? <div className="mt-1 h-5 pl-11" /> : null}
    </div>
  );
}
