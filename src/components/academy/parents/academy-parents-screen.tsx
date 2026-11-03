"use client";

import { collection, getDocs } from "firebase/firestore";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AcademyPanelRefreshButton } from "@/components/academy/academy-panel-refresh-button";
import { AcademyParentSignupLink } from "@/components/academy/academy-parent-signup-link";
import { useAcademyShell } from "@/components/academy/academy-shell";
import { GuardianDetailSheet } from "@/components/academy/parents/guardian-detail-sheet";
import { ParentCreateSheet } from "@/components/academy/parents/parent-create-sheet";
import { ParentLinkSheet } from "@/components/academy/parents/parent-link-sheet";
import { AppStateBadge, fmtDate, PushBadge } from "@/components/academy/parents/parent-ui";
import { StudentDetailSheet } from "@/components/academy/student-detail/student-detail-sheet";
import { useStudentDetailParam } from "@/components/academy/student-detail/use-student-detail-param";
import {
  blocksSamePhoneLink,
  buildGuardianDirectory,
  docToParentAccount,
  GUARDIAN_FILTER_LABELS,
  guardianFilterCounts,
  groupAppState,
  groupMatchesFilter,
  groupMatchesSearch,
  isAwaitingApproval,
  parentPushState,
  studentsMatchingPhone,
  type GuardianFilter,
  type GuardianGroup,
  type ParentAccountVM,
} from "@/lib/academy/parent-directory";
import { compareStudentsByName, docToStudent, guardianRelationLabel, type StudentVM } from "@/lib/academy/student-row";
import { useAcademyClasses } from "@/lib/academy/use-academy-classes";
import { useAcademyOptionList } from "@/lib/academy/use-academy-option-list";
import { academyParentsPath, academyStudentsPath } from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";
import { useAcademyListPoll } from "@/lib/firebase/use-academy-list-poll";
import { formatKrPhoneDisplay, formatKrPhoneDisplayOrDash } from "@/lib/phone/kr-phone";

const FILTERS: GuardianFilter[] = ["all", "none", "linked", "unlinked", "inactive", "push"];

const chipClass = (active: boolean) =>
  `shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
    active ? "border-[#222] bg-[#222] text-white" : "border-neutral-300/70 bg-white/60 text-neutral-700"
  }`;

const tabClass = (active: boolean) =>
  `flex-1 border-b-2 py-2.5 text-sm font-medium transition ${
    active ? "border-[#222] text-foreground" : "border-transparent text-neutral-500 hover:text-foreground"
  }`;

/** 보호자 상세 시트가 가리키는 묶음 — 계정이 있으면 그 계정이 붙은 카드를 따라간다(연결 뒤 카드가 옮겨 가도 유지) */
type OpenGroup = { key: string; uid: string | null };

type CreateTarget = { name: string; phone: string; studentIds: string[] };

/** 변경 뒤 서버 트리거 반영을 기다려 다시 읽는 시점 */
const FOLLOW_UP_REFRESH_MS = [2500, 8000] as const;

/**
 * 운영 › 학부모 관리(9-5) — 보호자 탭(번호 묶음 카드·검색·칩·가입 안내) / 승인 대기 탭(`?view=pending`).
 * 학생·학부모 목록을 한 번씩 읽어 클라이언트에서 묶는다(`parent-directory.ts`). 카드 → 보호자 상세 시트(주소 없음),
 * 자녀 → 학생 상세 시트(`?student=`, `view`는 유지). 버튼은 서버 권한(`operations.parents`)·상태와 같게 보인다.
 */
export function AcademyParentsScreen() {
  const { academyId, permissions } = useAcademyShell();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const view = searchParams.get("view") === "pending" ? "pending" : "guardians";
  const detail = useStudentDetailParam();
  const { classes } = useAcademyClasses(academyId);
  const { items: relations } = useAcademyOptionList(academyId, "guardianRelations");
  const canBilling = permissions.can(["billing.invoices", "billing.collections"]);

  const [students, setStudents] = useState<StudentVM[]>([]);
  const [accounts, setAccounts] = useState<ParentAccountVM[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<GuardianFilter>("all");
  const [search, setSearch] = useState("");
  const [openGroup, setOpenGroup] = useState<OpenGroup | null>(null);
  const [linkTarget, setLinkTarget] = useState<ParentAccountVM | null>(null);
  const [createTarget, setCreateTarget] = useState<CreateTarget | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const db = getFirebaseDb();
      const [studentSnap, parentSnap] = await Promise.all([
        getDocs(collection(db, academyStudentsPath(academyId))),
        getDocs(collection(db, academyParentsPath(academyId))),
      ]);
      const list = studentSnap.docs.map((d) => docToStudent(d.id, d.data() as Record<string, unknown>));
      list.sort(compareStudentsByName);
      setStudents(list);
      setAccounts(parentSnap.docs.map((d) => docToParentAccount(d.id, d.data() as Record<string, unknown>)));
      setNowMs(Date.now());
      setLoadError(null);
    } catch {
      setLoadError("학부모·원생 목록을 불러오지 못했습니다.");
    } finally {
      setLoaded(true);
    }
  }, [academyId]);

  const { refresh, busy } = useAcademyListPoll(loadAll, [academyId]);

  /**
   * 연결·해제·만들기·삭제 뒤 다시 읽기 — 계정 상태(승인 대기 ↔ 연결됨)와 연결 요약은 서버 트리거가 조금 뒤에 바꾸므로
   * 바로 한 번 + 2.5초 뒤 + 8초 뒤 한 번씩 더 읽는다(바로 읽으면 마지막 자녀를 해제한 계정이 "연결됨"으로 남아 보임,
   * 운영에서는 트리거 콜드 스타트가 2.5초를 넘을 수 있음). 표시만 늦을 뿐 서버 판단은 맞다.
   */
  const followUpTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearFollowUps = useCallback(() => {
    for (const t of followUpTimers.current) clearTimeout(t);
    followUpTimers.current = [];
  }, []);
  const refreshAfterChange = useCallback(() => {
    refresh();
    clearFollowUps();
    followUpTimers.current = FOLLOW_UP_REFRESH_MS.map((ms) => setTimeout(refresh, ms));
  }, [refresh, clearFollowUps]);
  useEffect(() => clearFollowUps, [clearFollowUps]);

  const groups = useMemo(() => buildGuardianDirectory(students, accounts), [students, accounts]);
  const counts = useMemo(() => guardianFilterCounts(groups, nowMs), [groups, nowMs]);
  const visible = useMemo(
    () => groups.filter((g) => groupMatchesFilter(g, filter, nowMs) && groupMatchesSearch(g, search)),
    [groups, filter, nowMs, search],
  );
  const matchedVisible = visible.filter((g) => !g.unmatched);
  const unmatchedVisible = visible.filter((g) => g.unmatched);
  const unmatchedTotal = groups.filter((g) => g.unmatched).length;

  const awaiting = useMemo(
    () => accounts.filter(isAwaitingApproval).sort((a, b) => b.createdAtMs - a.createdAtMs),
    [accounts],
  );

  const resolveGroup = useCallback(
    (o: OpenGroup | null): GuardianGroup | null => {
      if (!o) return null;
      if (o.uid) {
        const byUid = groups.find((g) => g.accounts.some((a) => a.uid === o.uid));
        if (byUid) return byUid;
      }
      return groups.find((g) => g.key === o.key) ?? null;
    },
    [groups],
  );
  const shownGroup = resolveGroup(openGroup);
  // 다른 곳에서 계정이 삭제돼 묶음이 없어지면 상세 시트를 닫는다
  useEffect(() => {
    if (openGroup && loaded && !loadError && !shownGroup) setOpenGroup(null);
  }, [openGroup, loaded, loadError, shownGroup]);

  const setView = (next: "guardians" | "pending") => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "pending") params.set("view", "pending");
    else params.delete("view");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // 새 상세 시트를 열 때는 이전 결과 안내를 지운다(다른 보호자의 안내가 시트 안에 남지 않게)
  const openGroupCard = (g: GuardianGroup) => {
    setNotice(null);
    setOpenGroup({ key: g.key, uid: g.accounts[0]?.uid ?? null });
  };
  const openAccount = (uid: string) => {
    const g = groups.find((x) => x.accounts.some((a) => a.uid === uid));
    if (!g) return;
    setNotice(null);
    setOpenGroup({ key: g.key, uid });
  };

  const showNotice = useCallback((message: string) => setNotice(message), []);
  const onDetailChanged = useCallback(
    (message: string) => {
      setNotice(message);
      refresh();
    },
    [refresh],
  );

  const studentOpen = detail.studentId !== null;

  const renderGroupCard = (g: GuardianGroup) => {
    const rep = g.accounts[0] ?? null;
    const push = rep ? parentPushState(rep, nowMs) : null;
    const relationText = g.relationIds.map((id) => guardianRelationLabel(id, relations)).join(", ");
    return (
      <li key={g.key}>
        <button
          type="button"
          onClick={() => openGroupCard(g)}
          className="glass-card block w-full px-4 py-3 text-left transition hover:bg-white/45 active:bg-white/55"
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate font-medium text-foreground">{g.displayName}</span>
            {relationText ? <span className="shrink-0 text-[11px] text-neutral-500">{relationText}</span> : null}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {g.accounts.length > 1 ? (
                <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-950">
                  계정 {g.accounts.length}개
                </span>
              ) : null}
              <AppStateBadge state={groupAppState(g)} extra={g.accounts.length > 1 ? ` +${g.accounts.length - 1}` : undefined} />
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-neutral-600">
            {formatKrPhoneDisplayOrDash(g.phone)}
            {g.appName ? ` · 앱: ${g.appName}` : ""}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {g.children.length === 0 ? (
              <span className="text-[11px] text-neutral-400">연결된 원생 없음</span>
            ) : (
              g.children.map((c) => (
                <span
                  key={c.student.id}
                  className={`rounded-full border px-2 py-0.5 text-[10px] ${
                    c.linkedUids.length > 0
                      ? "border-emerald-400/60 text-emerald-900"
                      : "border-neutral-300/70 text-neutral-700"
                  }`}
                >
                  {c.student.name || "(이름 없음)"}
                </span>
              ))
            )}
            {push ? (
              <span className="ml-auto">
                <PushBadge state={push} />
              </span>
            ) : null}
          </div>
        </button>
      </li>
    );
  };

  if (!loaded) {
    return <p className="py-12 text-center text-sm text-neutral-400">불러오는 중…</p>;
  }

  return (
    <div className="space-y-3">
      <nav className="flex gap-1" role="tablist" aria-label="학부모 관리">
        <button
          type="button"
          role="tab"
          aria-selected={view === "guardians"}
          onClick={() => setView("guardians")}
          className={tabClass(view === "guardians")}
        >
          보호자
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "pending"}
          onClick={() => setView("pending")}
          className={tabClass(view === "pending")}
        >
          승인 대기{awaiting.length > 0 ? ` ${awaiting.length}` : ""}
        </button>
      </nav>

      {notice ? (
        <p
          className="break-keep rounded-2xl bg-emerald-500/10 px-3 py-2 text-center text-xs text-emerald-900 ring-1 ring-emerald-500/20"
          role="status"
        >
          {notice}
        </p>
      ) : null}
      {loadError ? (
        <p className="break-keep rounded-2xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
          {loadError}{" "}
          <button type="button" className="underline" onClick={refresh}>
            다시 시도
          </button>
        </p>
      ) : null}

      {view === "pending" ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="break-keep text-sm text-neutral-600">
              가입했지만 아직 원생과 연결되지 않은 계정 <span className="font-semibold text-foreground">{awaiting.length}</span>
            </p>
            <AcademyPanelRefreshButton busy={busy} onRefreshAction={refresh} />
          </div>
          <ul className="space-y-2 pb-8">
            {awaiting.length === 0 ? (
              <li className="glass-card break-keep px-4 py-10 text-center text-sm text-neutral-500">
                승인을 기다리는 학부모가 없습니다.
              </li>
            ) : (
              awaiting.map((a) => {
                const matched = studentsMatchingPhone(students, a.phoneKey);
                const others = accounts.filter(
                  (o) => o.uid !== a.uid && a.phoneKey.length > 0 && o.phoneKey === a.phoneKey,
                );
                const blocked = others.some(blocksSamePhoneLink);
                return (
                  <li key={a.uid}>
                    <button
                      type="button"
                      onClick={() => setLinkTarget(a)}
                      className="glass-card block w-full px-4 py-3 text-left transition hover:bg-white/45 active:bg-white/55"
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 truncate font-medium text-foreground">{a.displayName || "이름 없음"}</span>
                        <span className="ml-auto shrink-0 text-[11px] text-neutral-500">가입 {fmtDate(a.createdAtMs)}</span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-neutral-600">{formatKrPhoneDisplayOrDash(a.phone)}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        {!a.phone ? (
                          <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-800">
                            번호 없음
                          </span>
                        ) : (
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              matched.length > 0 ? "bg-sky-500/15 text-sky-900" : "bg-neutral-500/12 text-neutral-600"
                            }`}
                          >
                            {matched.length > 0 ? `번호 일치 원생 ${matched.length}명` : "번호 일치 원생 없음"}
                          </span>
                        )}
                        {others.length > 0 ? (
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              blocked ? "bg-red-500/12 text-red-800" : "bg-amber-500/20 text-amber-950"
                            }`}
                          >
                            {blocked ? "같은 번호로 연결된 계정 있음" : `같은 번호 계정 ${others.length}개`}
                          </span>
                        ) : null}
                      </div>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </>
      ) : (
        <>
          <AcademyParentSignupLink academyId={academyId} />

          <div className="flex items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="이름·번호·자녀 이름 검색"
              className="min-w-0 flex-1 rounded-2xl border border-neutral-300/60 bg-white/60 px-4 py-2.5 text-sm text-foreground outline-none placeholder:text-neutral-400 focus:border-[#4a90e2]/50"
              aria-label="보호자 검색"
            />
            <AcademyPanelRefreshButton busy={busy} onRefreshAction={refresh} />
          </div>

          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="보호자 필터">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={chipClass(filter === f)}
              >
                {GUARDIAN_FILTER_LABELS[f]} {counts[f]}
              </button>
            ))}
          </div>

          <ul className="space-y-2">
            {matchedVisible.length === 0 ? (
              <li className="glass-card break-keep px-4 py-10 text-center text-sm text-neutral-500">
                {groups.length === 0
                  ? "원생 정보에 보호자 번호를 입력하면 여기에 보호자별로 모입니다."
                  : "조건에 맞는 보호자가 없습니다."}
              </li>
            ) : (
              matchedVisible.map(renderGroupCard)
            )}
          </ul>

          {unmatchedTotal > 0 ? (
            <section className="space-y-2 pb-8 pt-2">
              <h2 className="break-keep text-xs font-semibold text-neutral-600">
                원생 보호자 번호와 맞지 않는 계정 {unmatchedTotal}
              </h2>
              {unmatchedVisible.length === 0 ? (
                <p className="text-xs text-neutral-400">조건에 맞는 계정이 없습니다.</p>
              ) : (
                <ul className="space-y-2">{unmatchedVisible.map(renderGroupCard)}</ul>
              )}
            </section>
          ) : (
            <div className="pb-8" />
          )}
        </>
      )}

      {shownGroup ? (
        <GuardianDetailSheet
          key={shownGroup.key}
          academyId={academyId}
          group={shownGroup}
          relations={relations}
          canBilling={canBilling}
          nowMs={nowMs}
          notice={notice}
          escapeBlocked={studentOpen || linkTarget !== null || createTarget !== null}
          onOpenStudentAction={(id) => detail.open(id)}
          onLinkAction={(a) => setLinkTarget(a)}
          onCreateAction={() =>
            setCreateTarget({
              name: shownGroup.entries.find((e) => e.guardian.isPrimary && e.guardian.name)?.guardian.name ??
                shownGroup.entries.find((e) => e.guardian.name)?.guardian.name ??
                "",
              phone: formatKrPhoneDisplay(shownGroup.phone),
              studentIds: shownGroup.children.map((c) => c.student.id),
            })
          }
          onReloadAction={refreshAfterChange}
          onNoticeAction={showNotice}
          onCloseAction={() => setOpenGroup(null)}
        />
      ) : null}

      {linkTarget ? (
        <ParentLinkSheet
          key={linkTarget.uid}
          academyId={academyId}
          account={linkTarget}
          students={students}
          accounts={accounts}
          classes={classes}
          escapeBlocked={studentOpen}
          onOpenStudentAction={(id) => detail.open(id)}
          onOpenAccountAction={(uid) => {
            setLinkTarget(null);
            openAccount(uid);
          }}
          onReloadAction={refreshAfterChange}
          onCloseAction={() => setLinkTarget(null)}
          onDoneAction={(message) => {
            setLinkTarget(null);
            setNotice(message);
          }}
        />
      ) : null}

      {createTarget ? (
        <ParentCreateSheet
          academyId={academyId}
          initialName={createTarget.name}
          initialPhone={createTarget.phone}
          initialStudentIds={createTarget.studentIds}
          students={students}
          classes={classes}
          escapeBlocked={studentOpen}
          onOpenStudentAction={(id) => detail.open(id)}
          onReloadAction={refreshAfterChange}
          onCloseAction={() => setCreateTarget(null)}
          onDoneAction={(message) => {
            setCreateTarget(null);
            setNotice(message);
          }}
        />
      ) : null}

      {detail.studentId ? (
        <StudentDetailSheet
          key={detail.studentId}
          academyId={academyId}
          studentId={detail.studentId}
          tabParam={detail.tabParam}
          permissions={permissions}
          onTabChangeAction={detail.setTab}
          onCloseAction={detail.close}
          onChangedAction={onDetailChanged}
        />
      ) : null}
    </div>
  );
}
