const glassCard = "glass-card";

type StudentListSectionSkeletonProps = {
  /** 스켈레톤 카드 개수 */
  rows?: number;
  /** 접근성 라벨 */
  label?: string;
};

/**
 * 선생님·학부모 대시보드의 학생 목록 영역 초기 로딩용 스켈레톤.
 */
export function StudentListSectionSkeleton({
  rows = 3,
  label = "학생 목록 불러오는 중",
}: StudentListSectionSkeletonProps) {
  return (
    <div
      className="space-y-2"
      aria-busy="true"
      aria-live="polite"
      aria-label={label}
    >
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={`student-list-skel-${i}`}
          className={`animate-pulse p-4 ${glassCard}`}
        >
          <div className="h-4 w-2/3 max-w-[12rem] rounded-md bg-neutral-300/60 dark:bg-neutral-600/50" />
          <div className="mt-3 h-3 w-1/2 max-w-[10rem] rounded-md bg-neutral-200/80 dark:bg-neutral-700/50" />
          <div className="mt-2 h-3 w-3/5 max-w-[11rem] rounded-md bg-neutral-200/70 dark:bg-neutral-700/45" />
          <div className="mt-4 flex gap-2">
            <div className="h-9 w-24 rounded-xl bg-neutral-200/70 dark:bg-neutral-700/45" />
            <div className="h-9 w-24 rounded-xl bg-neutral-200/60 dark:bg-neutral-700/40" />
          </div>
        </div>
      ))}
    </div>
  );
}
