"use client";

import { AcademyParentPanel } from "@/components/academy/academy-parent-panel";
import { AcademyStudentPanel } from "@/components/academy/academy-student-panel";
import { AcademyTeacherPanel } from "@/components/academy/academy-teacher-panel";
import {
  AcademyTreemap,
  AcademyTreemapFooter,
  type AcademyHeatmapItem,
} from "@/components/academy/academy-treemap";
import { COLLECTIONS, type Academy } from "@/lib/firebase/attn-schema";
import { signOut } from "firebase/auth";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  query,
  where,
} from "firebase/firestore";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { DashboardNotificationsModal } from "@/components/dashboard/dashboard-notifications-modal";
import { AttnTabLogo } from "@/components/dashboard/attn-tab-logo";
import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";
import { DashboardRoleHeader } from "@/components/dashboard/dashboard-role-header";
import { academyLabelForGreeting } from "@/lib/ui/dashboard-greetings";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";
import { useAcademyDashboardBell } from "@/lib/firebase/use-academy-dashboard-bell";

const glassCard = "glass-card";

type AcademySection = "home" | "teachers" | "parents" | "students";

function parseSection(raw: string | null): AcademySection {
  if (raw === "teachers" || raw === "parents" || raw === "students") {
    return raw;
  }
  return "home";
}

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

const SUMMARY_STAT_ROWS = [
  { key: "teachers" as const, label: "선생님" },
  { key: "parents" as const, label: "학부모" },
  { key: "students" as const, label: "학생" },
] as const;

type AcademySummaryCounts = {
  teachers: number;
  parents: number;
  students: number;
};

function IconMonitor({ active }: { active?: boolean }) {
  const stroke = active ? "#171717" : "#666";
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="4"
        width="18"
        height="12"
        rx="2"
        stroke={stroke}
        strokeWidth="1.6"
        fill={active ? "rgba(0,0,0,0.06)" : "none"}
      />
      <path
        d="M8 19h8M12 16v3"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconPerson({ active }: { active?: boolean }) {
  const stroke = active ? "#171717" : "#666";
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="8.5" r="3.2" stroke={stroke} strokeWidth="1.6" />
      <path
        d="M6.5 19c.8-3 2.8-5 5.5-5s4.7 2 5.5 5"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconBackpack({ active }: { active?: boolean }) {
  const stroke = active ? "#171717" : "#666";
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M8 7V6a4 4 0 018 0v1"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <rect
        x="5"
        y="7"
        width="14"
        height="13"
        rx="3"
        stroke={stroke}
        strokeWidth="1.6"
        fill={active ? "rgba(0,0,0,0.06)" : "none"}
      />
      <path
        d="M12 11v4"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function AcademyDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const configured = isFirebaseConfigured();
  const authProfile = useAuthProfile();

  const [gate, setGate] = useState<"loading" | "ready" | "forbidden" | "auth">(
    "loading",
  );
  const [academyId, setAcademyId] = useState<string | null>(null);
  const [academyName, setAcademyName] = useState<string | null>(null);
  const [showBack, setShowBack] = useState(false);
  /** 학원 ID·비밀번호 포털 로그인(커스텀 토큰) 세션 ? 오너 대시보드에서 연 경로와 구분 */
  const [isAcademyPortalSession, setIsAcademyPortalSession] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [summaryCounts, setSummaryCounts] =
    useState<AcademySummaryCounts | null>(null);
  const [summaryCountsError, setSummaryCountsError] = useState<string | null>(
    null,
  );
  const [heatmapItems, setHeatmapItems] = useState<AcademyHeatmapItem[] | null>(
    null,
  );
  const [heatmapError, setHeatmapError] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  const {
    items: academyBellItems,
    count: academyBellCount,
    error: academyBellError,
  } = useAcademyDashboardBell(academyId);

  const fromOwner = searchParams.get("from") === "owner";
  const queryAcademyId = searchParams.get("id")?.trim() ?? "";
  const section = parseSection(searchParams.get("section"));

  const navigateSection = useCallback(
    (s: AcademySection) => {
      const p = new URLSearchParams(searchParams.toString());
      if (s === "home") {
        p.delete("section");
      } else {
        p.set("section", s);
      }
      const qs = p.toString();
      router.replace(qs ? `/academy?${qs}` : "/academy", { scroll: false });
    },
    [router, searchParams],
  );

  const resolveSession = useCallback(async () => {
    if (!configured) {
      setGate("forbidden");
      return;
    }
    const auth = getFirebaseAuth();
    const user = auth.currentUser;
    if (!user) {
      setGate("auth");
      return;
    }

    let token;
    try {
      token = await user.getIdTokenResult(true);
    } catch {
      setGate("forbidden");
      return;
    }

    const claims = token.claims as { role?: string; academyId?: string };
    const isPortal = claims.role === "academy";
    const portalAcademyId =
      typeof claims.academyId === "string" ? claims.academyId : "";

    if (isPortal && portalAcademyId) {
      setAcademyId(portalAcademyId);
      setShowBack(false);
      setIsAcademyPortalSession(true);
      try {
        const snap = await getDoc(
          doc(getFirebaseDb(), COLLECTIONS.academies, portalAcademyId),
        );
        const data = snap.data() as Academy | undefined;
        setAcademyName(typeof data?.name === "string" ? data.name : null);
      } catch {
        setAcademyName(null);
      }
      setGate("ready");
      return;
    }

    if (fromOwner && queryAcademyId) {
      setIsAcademyPortalSession(false);
      try {
        const snap = await getDoc(
          doc(getFirebaseDb(), COLLECTIONS.academies, queryAcademyId),
        );
        if (!snap.exists()) {
          setGate("forbidden");
          return;
        }
        const data = snap.data() as Academy;
        if (data.ownerUid !== user.uid) {
          setGate("forbidden");
          return;
        }
        setAcademyId(queryAcademyId);
        setAcademyName(typeof data?.name === "string" ? data.name : null);
        setShowBack(true);
        setGate("ready");
      } catch {
        setGate("forbidden");
      }
      return;
    }

    setIsAcademyPortalSession(false);
    router.replace("/owner");
  }, [configured, fromOwner, queryAcademyId, router]);

  const onPortalLogout = useCallback(async () => {
    setLogoutBusy(true);
    try {
      await signOut(getFirebaseAuth());
    } finally {
      setLogoutBusy(false);
      router.replace("/login?role=academy");
    }
  }, [router]);

  const onHeaderLogout = useCallback(async () => {
    setLogoutBusy(true);
    try {
      await signOut(getFirebaseAuth());
    } finally {
      setLogoutBusy(false);
      router.replace("/login");
    }
  }, [router]);

  useEffect(() => {
    if (!configured) {
      return;
    }
    const auth = getFirebaseAuth();
    const unsub = auth.onAuthStateChanged((user) => {
      if (!user) {
        setGate("auth");
        return;
      }
      void resolveSession();
    });
    return () => unsub();
  }, [configured, resolveSession]);

  useEffect(() => {
    if (gate !== "ready" || !academyId) {
      setSummaryCounts(null);
      setSummaryCountsError(null);
      return;
    }
    let cancelled = false;
    setSummaryCountsError(null);
    const db = getFirebaseDb();
    (async () => {
      try {
        const [teachersSnap, parentsSnap, studentsSnap] = await Promise.all([
          getCountFromServer(
            collection(db, COLLECTIONS.academies, academyId, "teachers"),
          ),
          getCountFromServer(
            collection(db, COLLECTIONS.academies, academyId, "parents"),
          ),
          getCountFromServer(
            collection(db, COLLECTIONS.academies, academyId, "students"),
          ),
        ]);
        if (!cancelled) {
          setSummaryCounts({
            teachers: teachersSnap.data().count,
            parents: parentsSnap.data().count,
            students: studentsSnap.data().count,
          });
        }
      } catch {
        if (!cancelled) {
          setSummaryCounts(null);
          setSummaryCountsError("요약 인원을 불러오지 못했습니다.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate, academyId, section]);

  useEffect(() => {
    if (gate !== "ready" || !academyId || section !== "home") {
      return;
    }
    let cancelled = false;
    setHeatmapError(null);
    const db = getFirebaseDb();
    const sub = (name: "teachers" | "parents" | "students") =>
      collection(db, COLLECTIONS.academies, academyId, name);
    (async () => {
      try {
        const [stu, tp, tiNeed, tiSent, pp, piNeed, piSent] = await Promise.all(
          [
            getCountFromServer(sub("students")),
            getCountFromServer(
              query(
                sub("teachers"),
                where("status", "==", "pending_registration"),
              ),
            ),
            getCountFromServer(
              query(
                sub("teachers"),
                where("status", "==", "invitation_needed"),
              ),
            ),
            getCountFromServer(
              query(sub("teachers"), where("status", "==", "invitation_sent")),
            ),
            getCountFromServer(
              query(
                sub("parents"),
                where("status", "==", "pending_registration"),
              ),
            ),
            getCountFromServer(
              query(sub("parents"), where("status", "==", "invitation_needed")),
            ),
            getCountFromServer(
              query(sub("parents"), where("status", "==", "invitation_sent")),
            ),
          ],
        );
        if (!cancelled) {
          setHeatmapItems(
            buildAcademyHeatmapItems({
              students: stu.data().count,
              teachersPending: tp.data().count,
              teachersInviteNeeded: tiNeed.data().count,
              teachersInviteSent: tiSent.data().count,
              parentsPending: pp.data().count,
              parentsInviteNeeded: piNeed.data().count,
              parentsInviteSent: piSent.data().count,
            }),
          );
        }
      } catch {
        if (!cancelled) {
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
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate, academyId, section]);

  if (!configured) {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center px-4">
        <p className="text-sm text-neutral-600">Firebase 설정이 필요합니다.</p>
      </div>
    );
  }

  if (gate === "auth") {
    return (
      <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center gap-4 px-4">
        <p className="text-sm text-neutral-600">로그인이 필요합니다.</p>
        <Link
          href="/login"
          className="rounded-2xl bg-[#222] px-6 py-3 text-sm font-medium text-white dark:text-neutral-950 dark:bg-neutral-100 dark:text-neutral-950"
        >
          로그인
        </Link>
      </div>
    );
  }

  if (gate === "forbidden") {
    return (
      <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center gap-4 px-4">
        <p className="text-sm text-neutral-600 text-center max-w-xs">
          이 학원 대시보드에 접근할 권한이 없거나 주소가 올바르지 않습니다.
        </p>
        <Link
          href="/owner"
          className="rounded-2xl border border-neutral-300/70 bg-white/60 dark:border-white/12 dark:bg-white/10 px-6 py-3 text-sm font-medium text-foreground"
        >
          오너 대시보드
        </Link>
        <Link
          href="/login"
          className="text-xs text-neutral-500 underline-offset-2 hover:underline"
        >
          로그인
        </Link>
      </div>
    );
  }

  if (gate === "loading" || !academyId) {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center">
        <p className="text-sm text-neutral-500">불러오는 중…</p>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background pb-28">
      <DashboardRoleHeader
        title="학원 대시보드"
        affiliationLabel={academyLabelForGreeting(academyName, academyId)}
        menuIntro={
          showBack ? (
            <span className="text-neutral-600 dark:text-neutral-400">
              오너 계정에서 이 학원 대시보드를 보고 있어요.
            </span>
          ) : undefined
        }
        showBack={showBack}
        onBack={() => router.push("/owner")}
        backAriaLabel="오너 대시보드로 돌아가기"
        onHome={() => router.push("/")}
        showBellOnTitle
        showBellInBottomBar={false}
        onBellClick={() => setNotificationsOpen(true)}
        bellBadgeCount={academyBellCount}
        bottomTabs={[
          {
            id: "home",
            label: "요약",
            showLabel: false,
            icon: (active: boolean) => <AttnTabLogo active={active} />,
            active: section === "home",
            onSelect: () => navigateSection("home"),
          },
          {
            id: "teachers",
            label: "선생님",
            icon: (active: boolean) => <IconMonitor active={active} />,
            active: section === "teachers",
            onSelect: () => navigateSection("teachers"),
          },
          {
            id: "parents",
            label: "학부모",
            icon: (active: boolean) => <IconPerson active={active} />,
            active: section === "parents",
            onSelect: () => navigateSection("parents"),
          },
          {
            id: "students",
            label: "학생",
            icon: (active: boolean) => <IconBackpack active={active} />,
            active: section === "students",
            onSelect: () => navigateSection("students"),
          },
        ]}
        onLogout={
          isAcademyPortalSession
            ? () => void onPortalLogout()
            : () => void onHeaderLogout()
        }
        logoutBusy={logoutBusy}
        profile={authProfile}
      />

      <main className="mx-auto max-w-lg px-4 pt-4">
        <h2 className="mb-2 text-sm font-semibold text-foreground">요약</h2>
        <div className="grid grid-cols-3 gap-2">
          {SUMMARY_STAT_ROWS.map((c) => {
            const isActive = section === c.key;
            const isHomeCards = section === "home";
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
                onClick={() => navigateSection(c.key)}
                className={`flex flex-col items-center justify-center py-4 px-2 transition ${
                  isActive
                    ? "rounded-[1.75rem] border border-[#222]/20 bg-[#222] text-white shadow-md dark:border-white/25 dark:bg-neutral-100 dark:text-neutral-950"
                    : `glass-tile ${isHomeCards ? "glass-tile-hover" : ""}`
                }`}
              >
                <span
                  className={`text-[11px] font-medium ${
                    isActive
                      ? "text-white/90 dark:text-neutral-600"
                      : "text-neutral-500 dark:text-neutral-400"
                  }`}
                >
                  {c.label}
                </span>
                <span
                  className={`mt-1 text-xl font-semibold tabular-nums ${
                    isActive
                      ? "text-white dark:text-neutral-950"
                      : "text-foreground"
                  }`}
                >
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

        {section === "home" ? (
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

        {section === "teachers" ? (
          <section className="mt-6">
            <AcademyTeacherPanel academyId={academyId} />
          </section>
        ) : null}

        {section === "parents" ? (
          <section className="mt-6">
            <AcademyParentPanel academyId={academyId} />
          </section>
        ) : null}

        {section === "students" ? (
          <section className="mt-6">
            <AcademyStudentPanel academyId={academyId} />
          </section>
        ) : null}
      </main>

      <DashboardNotificationsModal
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
        heading="알림"
        items={academyBellItems}
        emptyLabel={academyBellError ?? "표시할 알림이 없습니다."}
      />

      <DashboardBottomScrim />
    </div>
  );
}
