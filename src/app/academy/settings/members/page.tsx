"use client";

import { collection, getDocs } from "firebase/firestore";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";
import { AcademyPanelRefreshButton } from "@/components/academy/academy-panel-refresh-button";
import { MemberInviteSheet } from "@/components/academy/member-invite-sheet";
import { MemberSheet } from "@/components/academy/member-sheet";
import { RoleFormSheet } from "@/components/academy/role-form-sheet";
import { HomeTabIcon } from "@/components/dashboard/attn-tab-logo";
import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";
import { DashboardRoleHeader } from "@/components/dashboard/dashboard-role-header";
import { ACADEMY_PERMISSION_GROUPS } from "@/lib/academy/permissions";
import { canChangeStaffAccount, type PermissionViewer } from "@/lib/academy/role-policy";
import { docToStaffRow, type StaffRowVM } from "@/lib/academy/staff-row";
import { useAcademyOptionList } from "@/lib/academy/use-academy-option-list";
import { useAcademyRoles, type AcademyRoleVM } from "@/lib/academy/use-academy-roles";
import { usePermissions } from "@/lib/academy/use-permissions";
import { academyStaffPath, type StaffAccountStatus } from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";
import { useAcademyListPoll } from "@/lib/firebase/use-academy-list-poll";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";

const glassCard = "glass-card";

const inputClass =
  "min-w-0 flex-1 rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-2.5 text-sm text-foreground shadow-inner outline-none placeholder:text-neutral-400 focus:border-[#4a90e2]/50 focus:bg-white/70";

type PageTab = "members" | "roles";

/** 목록에 보이는 계정 상태 — 순서가 정렬 순서(처리할 것 먼저) */
const MEMBER_STATUSES = ["pending_registration", "pending_setup", "active", "inactive"] as const;
type MemberStatus = (typeof MEMBER_STATUSES)[number];
type MemberFilter = "all" | MemberStatus;

const MEMBER_STATUS_LABELS: Record<MemberStatus, string> = {
  pending_registration: "가입 승인 대기",
  pending_setup: "첫 로그인 전",
  active: "사용 중",
  inactive: "비활성",
};

const MEMBER_STATUS_BADGE: Record<MemberStatus, string> = {
  pending_registration: "bg-amber-500/15 text-amber-900",
  pending_setup: "bg-sky-500/15 text-sky-900",
  active: "bg-emerald-500/15 text-emerald-900",
  inactive: "bg-neutral-500/15 text-neutral-700",
};

function memberStatus(status: StaffAccountStatus): MemberStatus | null {
  return (MEMBER_STATUSES as readonly string[]).includes(status) ? (status as MemberStatus) : null;
}

function statusOrder(row: StaffRowVM): number {
  const s = memberStatus(row.accountStatus);
  return s ? MEMBER_STATUSES.indexOf(s) : MEMBER_STATUSES.length;
}

/** 역할이 켜 둔 메뉴 요약 — "운영관리 3 · 수납관리 2" */
function roleSummary(role: AcademyRoleVM): string {
  const parts = ACADEMY_PERMISSION_GROUPS.flatMap((g) => {
    const n = g.permissions.filter((p) => role.permissions.includes(p.key)).length;
    if (n === 0) return [];
    return [n === g.permissions.length ? `${g.label} 전체` : `${g.label} ${n}`];
  });
  return parts.length > 0 ? parts.join(" · ") : "메뉴 권한 없음 (담당 반·학생만)";
}

function MembersInner({
  academyId,
  viewer,
  canEditStaff,
  initialTab,
}: {
  academyId: string;
  viewer: PermissionViewer;
  canEditStaff: boolean;
  initialTab: PageTab;
}) {
  const [tab, setTab] = useState<PageTab>(initialTab);
  const [staff, setStaff] = useState<StaffRowVM[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<MemberFilter>("all");
  const [queryText, setQueryText] = useState("");
  const [memberSheetId, setMemberSheetId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [roleSheet, setRoleSheet] = useState<{ role: AcademyRoleVM | null } | null>(null);
  const { roles, error: rolesError, refresh: refreshRoles } = useAcademyRoles(academyId, true);
  const { items: jobTitles } = useAcademyOptionList(academyId, "jobTitles");

  const loadStaff = useCallback(async () => {
    try {
      const snap = await getDocs(collection(getFirebaseDb(), academyStaffPath(academyId)));
      setStaff(snap.docs.map((d) => docToStaffRow(d.id, d.data() as Record<string, unknown>)));
      setListError(null);
    } catch (err) {
      setStaff([]);
      setListError(err instanceof Error ? err.message : "멤버 목록을 불러오지 못했습니다.");
    }
  }, [academyId]);

  const { refresh: refreshStaff, busy: listBusy } = useAcademyListPoll(loadStaff, [academyId]);

  const refreshAll = useCallback(() => {
    refreshStaff();
    refreshRoles();
  }, [refreshStaff, refreshRoles]);

  /** 계정이 있는 직원·게스트 */
  const members = useMemo(
    () =>
      staff
        .filter((r) => r.accountStatus !== "no_account")
        .sort((a, b) => statusOrder(a) - statusOrder(b) || a.displayName.localeCompare(b.displayName, "ko")),
    [staff],
  );

  /** 초대할 수 있는 직원 — 계정 없음·재직/휴직·게스트 아님 */
  const inviteCandidates = useMemo(
    () =>
      staff
        .filter((r) => r.accountStatus === "no_account" && r.employmentStatus !== "resigned" && !r.isGuest)
        .sort((a, b) => a.displayName.localeCompare(b.displayName, "ko")),
    [staff],
  );

  const roleName = useMemo(() => {
    const m = new Map((roles ?? []).map((r) => [r.id, r.name]));
    return (id: string | null) => (id ? m.get(id) ?? null : null);
  }, [roles]);

  const jobTitleLabel = useMemo(() => {
    const m = new Map(jobTitles.map((j) => [j.id, j.label]));
    return (id: string | null) => (id ? m.get(id) ?? null : null);
  }, [jobTitles]);

  const counts = useMemo(() => {
    const c: Record<MemberFilter, number> = {
      all: members.length,
      pending_registration: 0,
      pending_setup: 0,
      active: 0,
      inactive: 0,
    };
    for (const m of members) {
      const s = memberStatus(m.accountStatus);
      if (s) c[s] += 1;
    }
    return c;
  }, [members]);

  const filtered = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    return members.filter(
      (m) =>
        (filter === "all" || m.accountStatus === filter) &&
        (!q ||
          m.displayName.toLowerCase().includes(q) ||
          m.loginId.toLowerCase().includes(q) ||
          (roleName(m.roleId) ?? "").toLowerCase().includes(q)),
    );
  }, [members, filter, queryText, roleName]);

  const sheetTarget = memberSheetId ? members.find((m) => m.id === memberSheetId) ?? null : null;

  const tabButton = (id: PageTab, label: string) => (
    <button
      key={id}
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={`flex-1 rounded-xl py-2 text-sm font-medium transition ${
        tab === id ? "bg-white text-foreground shadow-sm" : "text-neutral-500"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-2xl bg-neutral-200/60 p-1" role="tablist" aria-label="멤버·권한">
        {tabButton("members", `멤버 ${members.length}`)}
        {tabButton("roles", `권한 ${roles?.length ?? "…"}`)}
      </div>

      {notice ? (
        <p className="rounded-2xl bg-emerald-500/10 px-3 py-2 text-center text-xs text-emerald-900 ring-1 ring-emerald-500/20">
          {notice}
        </p>
      ) : null}
      {listError || rolesError ? (
        <p className="rounded-2xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
          {listError ?? rolesError}
        </p>
      ) : null}

      {tab === "members" ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">
              멤버 {counts.all}명
              {counts.pending_registration > 0 ? (
                <span className="ml-1.5 text-xs font-medium text-amber-700">승인 대기 {counts.pending_registration}</span>
              ) : null}
            </h2>
            <div className="flex shrink-0 items-center gap-2">
              <AcademyPanelRefreshButton busy={listBusy} onRefreshAction={refreshAll} />
              <button
                type="button"
                disabled={!roles}
                onClick={() => {
                  setNotice(null);
                  setInviteOpen(true);
                }}
                className="rounded-[8px] bg-[#222] px-3 py-2 text-[11px] font-medium text-white shadow-sm hover:bg-[#333] disabled:opacity-50"
              >
                + 멤버 초대
              </button>
            </div>
          </div>

          <input
            type="search"
            className={`${inputClass} w-full`}
            placeholder="이름·로그인 ID·권한으로 검색"
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            aria-label="멤버 검색"
          />

          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label="계정 상태">
            {(["all", ...MEMBER_STATUSES] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition ${
                  filter === f ? "bg-[#222] text-white ring-[#222]" : "bg-white/60 text-neutral-700 ring-neutral-300/70"
                }`}
              >
                {f === "all" ? "전체" : MEMBER_STATUS_LABELS[f]} {counts[f]}
              </button>
            ))}
          </div>

          <ul className="space-y-2 pb-16">
            {filtered.length === 0 ? (
              <li className={`py-10 text-center text-sm text-neutral-500 ${glassCard}`}>
                {members.length === 0
                  ? "계정이 있는 멤버가 없습니다. 「+ 멤버 초대」로 초대해 보세요."
                  : "조건에 맞는 멤버가 없습니다."}
              </li>
            ) : (
              filtered.map((m) => {
                const s = memberStatus(m.accountStatus);
                const locked = !canChangeStaffAccount(viewer, { id: m.id, permissions: m.permissions });
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setNotice(null);
                        setMemberSheetId(m.id);
                      }}
                      className={`flex w-full items-center gap-3 p-4 text-left transition hover:bg-white/70 ${glassCard}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-foreground">{m.displayName || "(이름 없음)"}</span>
                          {m.id === viewer.uid ? <span className="text-[10px] text-neutral-500">나</span> : null}
                          {m.isGuest ? (
                            <span className="rounded-full bg-neutral-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-700">
                              게스트
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-1 block truncate text-xs text-neutral-500">
                          {roleName(m.roleId) ?? "권한 없음"}
                          {" · "}
                          <span className="font-mono">{m.loginId || (m.authProvider === "google" ? "Google" : "—")}</span>
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            s ? MEMBER_STATUS_BADGE[s] : "bg-neutral-500/15 text-neutral-700"
                          }`}
                        >
                          {s ? MEMBER_STATUS_LABELS[s] : "확인 필요"}
                        </span>
                        {locked && m.id !== viewer.uid ? (
                          <span className="text-[10px] text-neutral-400">상위 권한</span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">권한 {roles?.length ?? 0}개</h2>
            <div className="flex shrink-0 items-center gap-2">
              <AcademyPanelRefreshButton busy={listBusy} onRefreshAction={refreshAll} />
              <button
                type="button"
                onClick={() => {
                  setNotice(null);
                  setRoleSheet({ role: null });
                }}
                className="rounded-[8px] bg-[#222] px-3 py-2 text-[11px] font-medium text-white shadow-sm hover:bg-[#333]"
              >
                + 권한 만들기
              </button>
            </div>
          </div>
          <p className="text-[11px] text-neutral-500">
            권한은 멤버가 볼 수 있는 메뉴 묶음입니다. 원장은 항상 모든 메뉴를 쓸 수 있어요.
          </p>

          <ul className="space-y-2 pb-16">
            {roles === null ? (
              <li className={`py-10 text-center text-sm text-neutral-500 ${glassCard}`}>
                {rolesError ?? "불러오는 중…"}
              </li>
            ) : (
              roles.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setNotice(null);
                      setRoleSheet({ role: r });
                    }}
                    className={`flex w-full items-center gap-3 p-4 text-left transition hover:bg-white/70 ${glassCard}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-foreground">{r.name}</span>
                        {r.template ? (
                          <span className="rounded-full bg-neutral-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-700">
                            기본
                          </span>
                        ) : null}
                        {r.id === viewer.roleId ? <span className="text-[10px] text-neutral-500">내 권한</span> : null}
                      </span>
                      <span className="mt-1 block text-xs text-neutral-500">{roleSummary(r)}</span>
                    </span>
                    <span className="shrink-0 text-xs text-neutral-500">멤버 {r.memberCount}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </>
      )}

      {sheetTarget ? (
        <MemberSheet
          academyId={academyId}
          target={sheetTarget}
          roles={roles}
          viewer={viewer}
          jobTitleLabel={jobTitleLabel(sheetTarget.jobTitleId)}
          canEditStaff={canEditStaff}
          onCloseAction={() => setMemberSheetId(null)}
          onChangedAction={(message) => {
            setNotice(message);
            refreshAll();
          }}
          onClosedWithMessageAction={(message) => {
            setMemberSheetId(null);
            setNotice(message);
            refreshAll();
          }}
        />
      ) : null}

      {inviteOpen && roles ? (
        <MemberInviteSheet
          academyId={academyId}
          roles={roles}
          viewer={viewer}
          candidates={inviteCandidates}
          onCloseAction={() => setInviteOpen(false)}
          onCreatedAction={refreshAll}
        />
      ) : null}

      {roleSheet ? (
        <RoleFormSheet
          academyId={academyId}
          role={roleSheet.role}
          viewer={viewer}
          onCloseAction={() => setRoleSheet(null)}
          onSavedAction={(message) => {
            setRoleSheet(null);
            setNotice(message);
            refreshAll();
          }}
        />
      ) : null}
    </div>
  );
}

function AcademyMembersInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { profile: authProfile } = useAuthProfile();
  const academyId = searchParams.get("id")?.trim() ?? "";
  const initialTab: PageTab = searchParams.get("tab") === "roles" ? "roles" : "members";
  const { loading, can, viewer } = usePermissions(academyId || null);
  const backHref = `/academy?id=${encodeURIComponent(academyId)}`;

  if (academyId && loading) {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center">
        <p className="text-sm text-neutral-500">불러오는 중…</p>
      </div>
    );
  }

  if (!academyId || !viewer || !can("settings.members")) {
    return (
      <div className="min-h-[100dvh] bg-background px-4 py-16 flex flex-col items-center justify-center">
        <p className="text-sm text-neutral-600 text-center">멤버 초대/권한 관리에 접근할 권한이 없습니다.</p>
        <Link href="/academy" className="mt-4 text-sm underline">
          대시보드로
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background pb-28">
      <DashboardRoleHeader
        title="멤버 초대/권한 관리"
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
        <MembersInner
          academyId={academyId}
          viewer={viewer}
          canEditStaff={can("settings.staff")}
          initialTab={initialTab}
        />
      </main>
      <DashboardBottomScrim />
    </div>
  );
}

export default function AcademyMembersPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-[100dvh] bg-background flex items-center justify-center">
          <p className="text-sm text-neutral-500">불러오는 중…</p>
        </div>
      }
    >
      <AcademyMembersInner />
    </Suspense>
  );
}
