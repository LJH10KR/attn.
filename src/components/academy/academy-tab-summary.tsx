"use client";

import { useAcademyShell } from "@/components/academy/academy-shell";
import { AcademySummaryCard } from "@/components/academy/academy-summary-card";
import { academyTabMenus } from "@/lib/academy/academy-routes";
import type { AcademyNavTab } from "@/lib/academy/permissions";
import { useAcademyMenuStats } from "@/lib/academy/use-academy-menu-stats";

/** 탭 첫 화면(운영·수납·수업·설정) — 권한 있는 상세 메뉴만, 숫자 배지와 함께 */
export function AcademyTabSummary({ tab }: { tab: AcademyNavTab }) {
  const { academyId, permissions, href } = useAcademyShell();
  const { stats } = useAcademyMenuStats(academyId, tab, permissions.can);
  const menus = academyTabMenus(tab).menus.filter((m) => permissions.can(m.access));

  return (
    <AcademySummaryCard
      rows={menus.map((m) => {
        const stat = stats[m.permission];
        return {
          key: m.permission,
          label: m.label,
          // 예: 승인 대기 학부모가 있으면 학부모 관리의 승인 대기 탭(`?view=pending`)으로
          href: stat?.query ? `${href(m.sub)}?${stat.query}` : href(m.sub),
          ready: m.ready,
          summary: stat?.summary,
          detail: stat?.detail,
          badge: stat?.badge,
        };
      })}
    />
  );
}
