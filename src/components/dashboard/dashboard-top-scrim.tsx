/**
 * 상단 고정 헤더 뒤에서 스크롤 콘텐츠가 겹쳐 보일 때 옅은 페이드·블러 스크림.
 *
 * 맨 위(노치·상태줄 쪽)는 불투명·블러를 강하게 두고, 아래로 갈수록 마스크로 서서히 걷어냅니다.
 * 레이어 하단은 투명으로 닫아 `backdrop-filter`가 끊기는 수평선이 덜 보이게 합니다.
 */
export function DashboardTopScrim() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-20 h-[120px] bg-gradient-to-b from-background/92 from-0% via-background/78 via-[18%] via-background/52 via-[36%] to-transparent to-100% backdrop-blur-[3px] dark:from-background/88 dark:via-background/72 dark:via-[20%] dark:via-background/46 dark:via-[38%]"
      style={{
        WebkitMaskImage:
          "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.97) 10%, rgba(0,0,0,0.9) 24%, rgba(0,0,0,0.55) 50%, rgba(0,0,0,0.18) 76%, transparent 100%)",
        maskImage:
          "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.97) 10%, rgba(0,0,0,0.9) 24%, rgba(0,0,0,0.55) 50%, rgba(0,0,0,0.18) 76%, transparent 100%)",
      }}
    />
  );
}
