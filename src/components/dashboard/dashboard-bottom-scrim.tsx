/**
 * 하단 고정 네비 뒤에서 스크롤 콘텐츠가 겹쳐 보일 때 옅은 페이드·블러 스크림.
 * `DashboardTopScrim`과 대칭: 맨 아래가 가장 진하고, 위로 갈수록 마스크로 서서히 걷어냅니다.
 */
export function DashboardBottomScrim() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 bottom-0 z-20 h-[160px] bg-gradient-to-t from-background/92 from-0% via-background/78 via-[18%] via-background/52 via-[36%] to-transparent to-100% backdrop-blur-[3px] dark:from-background/88 dark:via-background/72 dark:via-[20%] dark:via-background/46 dark:via-[38%]"
      style={{
        WebkitMaskImage:
          "linear-gradient(to top, rgba(0,0,0,1) 0%, rgba(0,0,0,0.97) 10%, rgba(0,0,0,0.9) 24%, rgba(0,0,0,0.55) 50%, rgba(0,0,0,0.18) 76%, transparent 100%)",
        maskImage:
          "linear-gradient(to top, rgba(0,0,0,1) 0%, rgba(0,0,0,0.97) 10%, rgba(0,0,0,0.9) 24%, rgba(0,0,0,0.55) 50%, rgba(0,0,0,0.18) 76%, transparent 100%)",
      }}
    />
  );
}
