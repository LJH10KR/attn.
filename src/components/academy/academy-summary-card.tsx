"use client";

import Link from "next/link";

export type AcademySummaryRow = {
  key: string;
  label: string;
  href: string;
  /** 거짓이면 "준비 중" 표시(경로는 열림) */
  ready: boolean;
  /** 오른쪽 보조 문구(원생 12명 등) — 불러오는 중이면 "…" */
  summary?: string | null;
  /** 처리할 일 숫자 배지(승인 대기 등) — 0이면 숨김 */
  badge?: number;
};

function ChevronIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0 text-neutral-400">
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * 탭 요약 화면·홈 카테고리 카드 공용 — 상세 메뉴 진입 행 목록.
 * `title`·`href`를 주면 카드 머리글이 해당 탭 요약으로 가는 링크가 된다(홈에서 사용).
 */
export function AcademySummaryCard({
  title,
  href,
  rows,
  emptyLabel = "볼 수 있는 메뉴가 없습니다.",
}: {
  title?: string;
  href?: string;
  rows: AcademySummaryRow[];
  emptyLabel?: string;
}) {
  return (
    <section className="glass-card overflow-hidden p-0">
      {title ? (
        href ? (
          <Link
            href={href}
            className="flex items-center justify-between gap-2 px-4 pb-1 pt-3 text-sm font-semibold text-foreground"
          >
            {title}
            <ChevronIcon />
          </Link>
        ) : (
          <h2 className="px-4 pb-1 pt-3 text-sm font-semibold text-foreground">{title}</h2>
        )
      ) : null}
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-neutral-500">{emptyLabel}</p>
      ) : (
        <ul className="divide-y divide-neutral-200/70 dark:divide-white/10">
          {rows.map((r) => (
            <li key={r.key}>
              <Link
                href={r.href}
                className="flex items-center gap-3 px-4 py-3.5 transition hover:bg-white/50 dark:hover:bg-white/5"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{r.label}</span>
                {!r.ready ? (
                  <span className="shrink-0 rounded-full bg-neutral-500/15 px-2 py-0.5 text-[10px] font-semibold text-neutral-600 dark:text-neutral-300">
                    준비 중
                  </span>
                ) : null}
                {r.summary ? (
                  <span className="shrink-0 text-xs tabular-nums text-neutral-500">{r.summary}</span>
                ) : null}
                {r.badge && r.badge > 0 ? (
                  <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-red-600 px-1.5 text-[10px] font-bold leading-none text-white">
                    {r.badge > 99 ? "99+" : r.badge}
                  </span>
                ) : null}
                <ChevronIcon />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
