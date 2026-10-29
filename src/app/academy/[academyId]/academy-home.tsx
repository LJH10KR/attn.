"use client";

import { AcademyParentSignupLink } from "@/components/academy/academy-parent-signup-link";
import { useAcademyShell } from "@/components/academy/academy-shell";
import {
  AcademyTreemap,
  AcademyTreemapFooter,
  type AcademyHeatmapItem,
} from "@/components/academy/academy-treemap";
import {
  ACADEMY_DASHBOARD_STATS_DOC_ID,
  ACADEMY_DASHBOARD_STATS_SCHEMA_VERSION,
  COLLECTIONS,
} from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";
import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  query,
  where,
} from "firebase/firestore";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { academyMenuPath } from "@/lib/academy/academy-routes";
import type { AcademyPermission } from "@/lib/academy/permissions";
import { SlideSwitch } from "@/components/ui/slide-switch";

const glassCard = "glass-card";

function cautionScore(n: number): number {
  return -Math.min(0.92, 0.14 + n * 0.055);
}

function mildConcernScore(n: number): number {
  return -Math.min(0.78, 0.08 + n * 0.04);
}

type AcademyHeatmapCounts = {
  students: number;
  teachersPending: number;
  teachersInviteNeeded: number;
  teachersInviteSent: number;
  parentsPending: number;
  parentsInviteNeeded: number;
  parentsInviteSent: number;
};

function buildAcademyHeatmapItems(
  c: AcademyHeatmapCounts,
): AcademyHeatmapItem[] {
  const items: AcademyHeatmapItem[] = [];
  if (c.students > 0) {
    items.push({
      id: "students",
      label: "재원 학생",
      value: c.students,
      metric: `${c.students}명`,
      score: Math.min(0.82, 0.4 + Math.min(c.students, 50) * 0.008),
    });
  }
  if (c.teachersPending > 0) {
    items.push({
      id: "teachers-pending",
      label: "등록 대기 중 선생님",
      value: c.teachersPending,
      metric: `${c.teachersPending}명`,
      score: cautionScore(c.teachersPending),
    });
  }
  if (c.teachersInviteNeeded > 0) {
    items.push({
      id: "teachers-invite",
      label: "초청 필요 선생님",
      value: c.teachersInviteNeeded,
      metric: `${c.teachersInviteNeeded}명`,
      score: cautionScore(c.teachersInviteNeeded + 1),
    });
  }
  if (c.teachersInviteSent > 0) {
    items.push({
      id: "teachers-invite-sent",
      label: "가입 대기 선생님",
      value: c.teachersInviteSent,
      metric: `${c.teachersInviteSent}명`,
      score: mildConcernScore(c.teachersInviteSent),
    });
  }
  if (c.parentsPending > 0) {
    items.push({
      id: "parents-pending",
      label: "등록 대기 중 학부모",
      value: c.parentsPending,
      metric: `${c.parentsPending}명`,
      score: cautionScore(c.parentsPending),
    });
  }
  if (c.parentsInviteNeeded > 0) {
    items.push({
      id: "parents-invite",
      label: "초청 필요 학부모",
      value: c.parentsInviteNeeded,
      metric: `${c.parentsInviteNeeded}명`,
      score: cautionScore(c.parentsInviteNeeded + 1),
    });
  }
  if (c.parentsInviteSent > 0) {
    items.push({
      id: "parents-invite-sent",
      label: "가입 대기 학부모",
      value: c.parentsInviteSent,
      metric: `${c.parentsInviteSent}명`,
      score: mildConcernScore(c.parentsInviteSent),
    });
  }
  if (items.length === 0) {
    return [
      {
        id: "heatmap-empty",
        label: "표시할 운영 지표가 없습니다",
        value: 1,
        metric: "—",
        score: 0,
      },
    ];
  }
  return items;
}

/** 요약 칸 — 해당 상세 메뉴 권한이 있을 때만 보임 */
const SUMMARY_STAT_ROWS: {
  key: keyof AcademySummaryCounts;
  label: string;
  permission: AcademyPermission;
}[] = [
  { key: "teachers", label: "선생님", permission: "settings.members" },
  { key: "parents", label: "학부모", permission: "operations.parents" },
  { key: "students", label: "학생", permission: "operations.students" },
];

/** 홈 집계(meta/dashboardStats) 읽기 권한 — 규칙과 같은 목록 */
const HOME_STATS_PERMISSIONS: AcademyPermission[] = [
  "operations.students",
  "operations.parents",
  "settings.members",
];

/** 집계 문서가 없을 때 직접 세는 컬렉션별 읽기 권한 — 규칙과 같은 목록(권한 없는 컬렉션은 세지 않음) */
const STAFF_READ_PERMISSIONS: AcademyPermission[] = [
  "settings.staff",
  "settings.members",
  "operations.students",
  "operations.classes",
];
const PARENTS_READ_PERMISSIONS: AcademyPermission[] = ["operations.parents", "operations.students"];
const STUDENTS_READ_PERMISSIONS: AcademyPermission[] = [
  "operations.students",
  "operations.parents",
  "lessons.attendance",
  "billing.invoices",
  "billing.collections",
  "billing.payments",
];

type AcademySummaryCounts = {
  teachers: number;
  parents: number;
  students: number;
};

/**
 * 학원 홈 — 1-E에서는 기존 홈을 새 레이아웃에 그대로 옮김(전면 개편은 5단계).
 * 키오스크 화면 자체는 학원 공통 레이아웃이 그린다.
 */
export function AcademyHome() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { academyId, permissions, kiosk } = useAcademyShell();
  const { can } = permissions;
  const canLoadStats = can(HOME_STATS_PERMISSIONS);
  const summaryRows = SUMMARY_STAT_ROWS.filter((c) => can(c.permission));
  // 키오스크 체크인·종료 PIN 확인은 서버가 출결 권한만 허용(종료 PIN 설정은 전체설정에서)
  const canKiosk = can("lessons.attendance");

  const [summaryCounts, setSummaryCounts] =
    useState<AcademySummaryCounts | null>(null);
  const [summaryCountsError, setSummaryCountsError] = useState<string | null>(
    null,
  );
  const [heatmapItems, setHeatmapItems] = useState<AcademyHeatmapItem[] | null>(
    null,
  );
  const [heatmapError, setHeatmapError] = useState<string | null>(null);

  const showBack = searchParams.get("from") === "owner";

  const onBackToOwner = useCallback(() => {
    // 오너 대시보드에서 진입한 경우엔 히스토리 복귀가 가장 저부하.
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
      return;
    }
    router.push("/owner");
  }, [router]);

  const loadDashboardStatsFallback = useCallback(async () => {
    const db = getFirebaseDb();
    const readable = {
      staff: can(STAFF_READ_PERMISSIONS),
      parents: can(PARENTS_READ_PERMISSIONS),
      students: can(STUDENTS_READ_PERMISSIONS),
    };
    // 읽을 권한이 없는 컬렉션은 0으로 — 일부 권한만 가진 직원에게 오류 문구를 띄우지 않음
    const count = (name: keyof typeof readable, status?: string) => {
      if (!readable[name]) return Promise.resolve(0);
      const col = collection(db, COLLECTIONS.academies, academyId, name);
      return getCountFromServer(status ? query(col, where("status", "==", status)) : col).then(
        (s) => s.data().count,
      );
    };
    try {
      const [teachers, parents, students, tp, tiNeed, tiSent, pp, piNeed, piSent] =
        await Promise.all([
          count("staff"),
          count("parents"),
          count("students"),
          count("staff", "pending_registration"),
          count("staff", "invitation_needed"),
          count("staff", "invitation_sent"),
          count("parents", "pending_registration"),
          count("parents", "invitation_needed"),
          count("parents", "invitation_sent"),
        ]);
      const heatmap: AcademyHeatmapCounts = {
        students,
        teachersPending: tp,
        teachersInviteNeeded: tiNeed,
        teachersInviteSent: tiSent,
        parentsPending: pp,
        parentsInviteNeeded: piNeed,
        parentsInviteSent: piSent,
      };
      setSummaryCounts({ teachers, parents, students });
      setSummaryCountsError(null);
      setHeatmapItems(buildAcademyHeatmapItems(heatmap));
      setHeatmapError(null);
    } catch {
      setSummaryCounts(null);
      setSummaryCountsError("요약 인원을 불러오지 못했습니다.");
      setHeatmapError("히트맵 데이터를 불러오지 못했습니다.");
      setHeatmapItems(
        buildAcademyHeatmapItems({
          students: 0,
          teachersPending: 0,
          teachersInviteNeeded: 0,
          teachersInviteSent: 0,
          parentsPending: 0,
          parentsInviteNeeded: 0,
          parentsInviteSent: 0,
        }),
      );
    }
  }, [academyId, can]);

  const loadDashboardStats = useCallback(async () => {
    const db = getFirebaseDb();
    try {
      const snap = await getDoc(
        doc(db, COLLECTIONS.academies, academyId, "meta", ACADEMY_DASHBOARD_STATS_DOC_ID),
      );
      const data = snap.data() as Record<string, unknown> | undefined;
      if (
        data &&
        data.schemaVersion === ACADEMY_DASHBOARD_STATS_SCHEMA_VERSION &&
        typeof data.teachers === "number" &&
        typeof data.parents === "number" &&
        typeof data.students === "number"
      ) {
        const heatmap: AcademyHeatmapCounts = {
          students: data.students as number,
          teachersPending: (data.teachersPending as number) ?? 0,
          teachersInviteNeeded: (data.teachersInviteNeeded as number) ?? 0,
          teachersInviteSent: (data.teachersInviteSent as number) ?? 0,
          parentsPending: (data.parentsPending as number) ?? 0,
          parentsInviteNeeded: (data.parentsInviteNeeded as number) ?? 0,
          parentsInviteSent: (data.parentsInviteSent as number) ?? 0,
        };
        setSummaryCounts({
          teachers: data.teachers as number,
          parents: data.parents as number,
          students: data.students as number,
        });
        setSummaryCountsError(null);
        setHeatmapItems(buildAcademyHeatmapItems(heatmap));
        setHeatmapError(null);
        return;
      }
    } catch {
      /* meta 문서 없음·권한 — fallback */
    }
    await loadDashboardStatsFallback();
  }, [academyId, loadDashboardStatsFallback]);

  useEffect(() => {
    if (!canLoadStats) return;
    void loadDashboardStats();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void loadDashboardStats();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [canLoadStats, loadDashboardStats]);

  return (
    <>
      {summaryRows.length > 0 ? (
        <>
          <h2 className="mb-2 text-sm font-semibold text-foreground">요약</h2>
          <div className="grid grid-cols-3 gap-2">
            {summaryRows.map((c) => {
              const countValue =
                summaryCounts !== null
                  ? String(summaryCounts[c.key])
                  : summaryCountsError
                    ? "—"
                    : "…";
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => router.push(academyMenuPath(academyId, c.permission))}
                  className="glass-tile glass-tile-hover flex flex-col items-center justify-center px-2 py-4 transition"
                >
                  <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                    {c.label}
                  </span>
                  <span className="mt-1 text-xl font-semibold tabular-nums text-foreground">
                    {countValue}
                  </span>
                </button>
              );
            })}
          </div>
          {summaryCountsError ? (
            <p className="mt-2 text-center text-[10px] text-red-600 dark:text-red-400">
              {summaryCountsError}
            </p>
          ) : null}
        </>
      ) : null}

      {showBack ? (
        <section className="mt-6">
          <div className={`${glassCard} flex items-center justify-between gap-4 px-4 py-3`}>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">오너 대시보드</p>
              <p className="mt-0.5 text-xs text-neutral-500">오너 계정에서 이 학원 대시보드를 열었습니다.</p>
            </div>
            <button
              type="button"
              onClick={onBackToOwner}
              className="shrink-0 rounded-[8px] bg-[#222] px-3 py-2 text-xs font-medium text-white dark:bg-neutral-100 dark:text-neutral-950"
            >
              돌아가기
            </button>
          </div>
        </section>
      ) : null}
      {can("operations.parents") ? (
        <section className="mt-4">
          <AcademyParentSignupLink academyId={academyId} />
        </section>
      ) : null}
      {canKiosk ? (
        <section className="mt-6">
          <div className={`${glassCard} flex items-center justify-between gap-4 px-4 py-3`}>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">학원 출석 키오스크 모드 전환</p>
              <p className="mt-0.5 text-xs text-neutral-500">
                키오스크 모드로 전환하면 전용 출석 체크 화면이 표시됩니다.
              </p>
            </div>
            <SlideSwitch
              checked={false}
              disabled={kiosk.busy}
              ariaLabel="출석 키오스크 모드 전환"
              onCheckedChangeAction={(next) => {
                if (next) kiosk.requestOn();
              }}
            />
          </div>
        </section>
      ) : null}
      {canLoadStats ? (
        <section className="mt-6">
          <h2 className="mb-3 text-sm font-semibold text-foreground">
            히트맵
          </h2>
          <div className={`overflow-hidden ${glassCard} p-0`}>
            {heatmapItems === null ? (
              <div className="py-14 text-center text-sm text-neutral-500">
                히트맵을 불러오는 중…
              </div>
            ) : (
              <>
                {heatmapError ? (
                  <p className="px-3 pt-3 text-center text-[10px] text-red-600 dark:text-red-400">
                    {heatmapError}
                  </p>
                ) : null}
                <AcademyTreemap items={heatmapItems} embedded footerOutside />
              </>
            )}
          </div>
          {heatmapItems !== null ? (
            <AcademyTreemapFooter
              className="mt-1.5"
              caption="타일 면적은 건수(볼륨), 색상은 상태 지표를 나타냅니다."
            />
          ) : null}
        </section>
      ) : null}
    </>
  );
}
