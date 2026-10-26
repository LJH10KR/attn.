"use client";

import { collection, getDocs } from "firebase/firestore";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";
import { AcademyPanelRefreshButton } from "@/components/academy/academy-panel-refresh-button";
import {
  StaffFormSheet,
  docToStaffRow,
  staffAccountLabel,
  type StaffRowVM,
} from "@/components/academy/staff-form-sheet";
import { HomeTabIcon } from "@/components/dashboard/attn-tab-logo";
import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";
import { DashboardRoleHeader } from "@/components/dashboard/dashboard-role-header";
import { useAcademyOptionList } from "@/lib/academy/use-academy-option-list";
import { usePermissions } from "@/lib/academy/use-permissions";
import { academyStaffPath, STAFF_EMPLOYMENT_STATUS_LABELS } from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";
import { useAcademyListPoll } from "@/lib/firebase/use-academy-list-poll";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";
import { formatKrPhoneDisplay, phoneMatchesSearch } from "@/lib/phone/kr-phone";

const glassCard = "glass-card";

type StaffFilter = "current" | "resigned" | "all";

const FILTERS: { id: StaffFilter; label: string }[] = [
  { id: "current", label: "재직·휴직" },
  { id: "resigned", label: "퇴사" },
  { id: "all", label: "전체" },
];

const inputClass =
  "min-w-0 flex-1 rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-2.5 text-sm text-foreground shadow-inner outline-none placeholder:text-neutral-400 focus:border-[#4a90e2]/50 focus:bg-white/70";

function matchesFilter(row: StaffRowVM, filter: StaffFilter): boolean {
  if (filter === "all") return true;
  if (filter === "resigned") return row.employmentStatus === "resigned";
  return row.employmentStatus !== "resigned";
}

function sortStaff(a: StaffRowVM, b: StaffRowVM): number {
  return a.displayName.localeCompare(b.displayName, "ko");
}

function StaffListInner({ academyId }: { academyId: string }) {
  const [rows, setRows] = useState<StaffRowVM[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StaffFilter>("current");
  const [queryText, setQueryText] = useState("");
  const [sheet, setSheet] = useState<{ target: StaffRowVM | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { items: jobTitles, save: saveJobTitles } = useAcademyOptionList(academyId, "jobTitles");

  const loadStaff = useCallback(async () => {
    try {
      const snap = await getDocs(collection(getFirebaseDb(), academyStaffPath(academyId)));
      const list = snap.docs
        .map((d) => docToStaffRow(d.id, d.data() as Record<string, unknown>))
        .filter((r) => !r.isGuest);
      list.sort(sortStaff);
      setRows(list);
      setListError(null);
    } catch (err) {
      setRows([]);
      setListError(err instanceof Error ? err.message : "직원 목록을 불러오지 못했습니다.");
    }
  }, [academyId]);

  const { refresh, busy: listBusy } = useAcademyListPoll(loadStaff, [academyId]);

  const jobTitleLabel = useMemo(() => {
    const m = new Map(jobTitles.map((j) => [j.id, j.label]));
    return (id: string | null) => (id ? m.get(id) ?? null : null);
  }, [jobTitles]);

  const jobTitleUsage = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) {
      if (r.jobTitleId) m[r.jobTitleId] = (m[r.jobTitleId] ?? 0) + 1;
    }
    return m;
  }, [rows]);

  const counts = useMemo(
    () => ({
      current: rows.filter((r) => matchesFilter(r, "current")).length,
      resigned: rows.filter((r) => matchesFilter(r, "resigned")).length,
      all: rows.length,
    }),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    return rows.filter(
      (r) =>
        matchesFilter(r, filter) &&
        (!q ||
          r.displayName.toLowerCase().includes(q) ||
          phoneMatchesSearch(r.phone, q) ||
          (jobTitleLabel(r.jobTitleId) ?? "").toLowerCase().includes(q)),
    );
  }, [rows, filter, queryText, jobTitleLabel]);

  return (
    <div className="space-y-4">
      {notice ? (
        <p className="rounded-2xl bg-emerald-500/10 px-3 py-2 text-center text-xs text-emerald-900 ring-1 ring-emerald-500/20">
          {notice}
        </p>
      ) : null}
      {listError ? (
        <p className="rounded-2xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
          {listError}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">직원 {counts.current}명</h2>
        <div className="flex shrink-0 items-center gap-2">
          <AcademyPanelRefreshButton busy={listBusy} onRefreshAction={refresh} />
          <button
            type="button"
            onClick={() => {
              setNotice(null);
              setSheet({ target: null });
            }}
            className="rounded-[8px] bg-[#222] px-3 py-2 text-[11px] font-medium text-white shadow-sm hover:bg-[#333]"
          >
            + 직원 추가
          </button>
        </div>
      </div>

      <input
        type="search"
        className={`${inputClass} w-full`}
        placeholder="이름·연락처·직무로 검색"
        value={queryText}
        onChange={(e) => setQueryText(e.target.value)}
        aria-label="직원 검색"
      />

      <div className="flex gap-2" role="tablist" aria-label="재직 상태">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition ${
              filter === f.id
                ? "bg-[#222] text-white ring-[#222]"
                : "bg-white/60 text-neutral-700 ring-neutral-300/70"
            }`}
          >
            {f.label} {counts[f.id]}
          </button>
        ))}
      </div>

      <ul className="space-y-2 pb-16">
        {filtered.length === 0 ? (
          <li className={`py-10 text-center text-sm text-neutral-500 ${glassCard}`}>
            {rows.length === 0 ? "등록된 직원이 없습니다." : "조건에 맞는 직원이 없습니다."}
          </li>
        ) : (
          filtered.map((r) => {
            const job = jobTitleLabel(r.jobTitleId);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => {
                    setNotice(null);
                    setSheet({ target: r });
                  }}
                  className={`flex w-full items-center gap-3 p-4 text-left transition hover:bg-white/70 ${glassCard}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-foreground">{r.displayName || "(이름 없음)"}</span>
                      {job ? <span className="text-xs text-neutral-500">{job}</span> : null}
                    </span>
                    <span className="mt-1 block text-xs text-neutral-500">
                      {formatKrPhoneDisplay(r.phone) || "연락처 없음"}
                      {r.hireDate ? ` · 입사 ${r.hireDate}` : ""}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    {r.employmentStatus !== "employed" ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          r.employmentStatus === "on_leave"
                            ? "bg-amber-500/15 text-amber-900"
                            : "bg-neutral-500/15 text-neutral-700"
                        }`}
                      >
                        {STAFF_EMPLOYMENT_STATUS_LABELS[r.employmentStatus]}
                      </span>
                    ) : null}
                    <span className="text-[10px] text-neutral-500">{staffAccountLabel(r.accountStatus)}</span>
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>

      {sheet ? (
        <StaffFormSheet
          academyId={academyId}
          target={sheet.target}
          jobTitles={jobTitles}
          onSaveJobTitlesAction={saveJobTitles}
          jobTitleUsage={jobTitleUsage}
          onCloseAction={() => setSheet(null)}
          onSavedAction={(message) => {
            setSheet(null);
            setNotice(message);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function AcademyStaffInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { profile: authProfile } = useAuthProfile();
  const academyId = searchParams.get("id")?.trim() ?? "";
  const { loading, can } = usePermissions(academyId || null);
  const backHref = `/academy?id=${encodeURIComponent(academyId)}`;

  if (academyId && loading) {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center">
        <p className="text-sm text-neutral-500">불러오는 중…</p>
      </div>
    );
  }

  if (!academyId || !can("settings.staff")) {
    return (
      <div className="min-h-[100dvh] bg-background px-4 py-16 flex flex-col items-center justify-center">
        <p className="text-sm text-neutral-600 text-center">직원 관리에 접근할 권한이 없습니다.</p>
        <Link href="/academy" className="mt-4 text-sm underline">
          대시보드로
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background pb-28">
      <DashboardRoleHeader
        title="직원 관리"
        affiliationLabel="설정"
        profile={authProfile}
        showBack
        onBackAction={() => router.back()}
        backAriaLabel="학원 대시보드로"
        onHomeAction={() => router.push("/")}
        onLogoutAction={() => router.push(backHref)}
        logoutLabel="닫기"
        bottomTabs={[
          {
            id: "home",
            label: "요약",
            showLabel: false,
            iconAction: (active: boolean) => <HomeTabIcon active={active} />,
            active: true,
            onSelectAction: () => router.push(backHref),
          },
        ]}
      />
      <main className="mx-auto max-w-lg px-4 pt-[26px]">
        <StaffListInner academyId={academyId} />
      </main>
      <DashboardBottomScrim />
    </div>
  );
}

export default function AcademyStaffPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-[100dvh] bg-background flex items-center justify-center">
          <p className="text-sm text-neutral-500">불러오는 중…</p>
        </div>
      }
    >
      <AcademyStaffInner />
    </Suspense>
  );
}
