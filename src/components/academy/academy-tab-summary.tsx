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
  const menus = academyTabMenus(tab).menus.filter((m) => permissions.can(m.permission));

  return (
    <AcademySummaryCard
      rows={menus.map((m) => ({
        key: m.permission,
        label: m.label,
        href: href(m.sub),
        ready: m.ready,
        summary: stats[m.permission]?.summary,
        badge: stats[m.permission]?.badge,
      }))}
    />
  );
}
