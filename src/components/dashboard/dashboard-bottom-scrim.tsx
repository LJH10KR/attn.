/**
 * 하단 고정 헤더 바로 위에서 스크롤 콘텐츠가 겹쳐 보이도록 옅은 페이드·블러 스크림.
 */
export function DashboardBottomScrim() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 bottom-0 z-20 h-16 bg-gradient-to-t from-background/90 via-neutral-200/22 via-[40%] to-transparent dark:via-neutral-500/14 dark:via-[45%] backdrop-blur-[2px]"
    />
  );
}
