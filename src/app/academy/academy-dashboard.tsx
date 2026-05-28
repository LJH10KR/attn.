"use client";

import { AcademyParentPanel } from "@/components/academy/academy-parent-panel";
import { AcademyAttendanceLogPanel } from "@/components/academy/academy-attendance-log-panel";
import { AcademyStudentPanel } from "@/components/academy/academy-student-panel";
import { AcademyTeacherPanel } from "@/components/academy/academy-teacher-panel";
import {
  AcademyTreemap,
  AcademyTreemapFooter,
  type AcademyHeatmapItem,
} from "@/components/academy/academy-treemap";
import {
  ACADEMY_DASHBOARD_STATS_DOC_ID,
  ACADEMY_DASHBOARD_STATS_SCHEMA_VERSION,
  COLLECTIONS,
  type Academy,
} from "@/lib/firebase/attn-schema";
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
import { useCallback, useEffect, useRef, useState } from "react";
import { DashboardNotificationsModal } from "@/components/dashboard/dashboard-notifications-modal";
import { AttnTabLogo } from "@/components/dashboard/attn-tab-logo";
import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";
import { DashboardRoleHeader } from "@/components/dashboard/dashboard-role-header";
import { academyLabelForGreeting } from "@/lib/ui/dashboard-greetings";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";
import { useAcademyDashboardBell } from "@/lib/firebase/use-academy-dashboard-bell";
import {
  AcademyKioskPanel,
  type KioskStudentRow,
} from "@/components/academy/academy-kiosk-panel";
import { PinPadModal } from "@/components/academy/pin-pad-modal";
import { httpsCallable } from "firebase/functions";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import type { AcademyKioskSettingsPublic } from "@/lib/firebase/attn-schema";
import {
  isKioskModeActive,
  kioskModeStorageKey,
  loadKioskStudentRows,
} from "@/lib/academy/kiosk-student-rows";
import { verifyKioskExitPinAndClear } from "@/lib/academy/kiosk-exit";
import { FirebaseError } from "firebase/app";
import { SlideSwitch } from "@/components/ui/slide-switch";

const glassCard = "glass-card";

type AcademySection = "home" | "teachers" | "parents" | "students" | "notifications";

function parseSection(raw: string | null): AcademySection {
  if (raw === "teachers" || raw === "parents" || raw === "students" || raw === "notifications") {
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

function IconBellMini({ active }: { active?: boolean }) {
  const stroke = active ? "#171717" : "#666";
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7 10a5 5 0 0 1 10 0v4.2c0 .7.2 1.38.56 1.98L19 18H5l1.44-1.82c.36-.6.56-1.28.56-1.98V10Z"
        stroke={stroke}
        strokeWidth="1.6"
        fill={active ? "rgba(0,0,0,0.06)" : "none"}
      />
      <path d="M10 19a2 2 0 0 0 4 0" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
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
  const [kioskMode, setKioskMode] = useState(false);
  const [kioskSettings, setKioskSettings] =
    useState<AcademyKioskSettingsPublic | null>(null);
  const [kioskRows, setKioskRows] = useState<KioskStudentRow[]>([]);
  const [kioskRowsBusy, setKioskRowsBusy] = useState(false);
  const [kioskEnableConfirmOpen, setKioskEnableConfirmOpen] = useState(false);
  const [kioskExitPinOpen, setKioskExitPinOpen] = useState(false);
  const [kioskExitPinError, setKioskExitPinError] = useState<string | null>(null);
  const [kioskActionBusy, setKioskActionBusy] = useState(false);
  const [kioskToast, setKioskToast] = useState<string | null>(null);
  const pendingSectionAfterExitRef = useRef<AcademySection | null>(null);
  const sectionExitPromptedRef = useRef(false);

  const {
    items: academyBellItems,
    count: academyBellCount,
    error: academyBellError,
    dismissOne: dismissAcademyBellOne,
    dismissAllVisible: dismissAcademyBellAll,
    refresh: refreshAcademyBell,
  } = useAcademyDashboardBell(academyId);

  const fromOwner = searchParams.get("from") === "owner";
  const queryAcademyId = searchParams.get("id")?.trim() ?? "";
  const section = parseSection(searchParams.get("section"));

  useEffect(() => {
    if (notificationsOpen) refreshAcademyBell();
  }, [notificationsOpen, refreshAcademyBell]);

  useEffect(() => {
    if (!academyId || section === "notifications") return;
    refreshAcademyBell();
  }, [academyId, section, refreshAcademyBell]);

  const loadKioskSettings = useCallback(async (aid: string) => {
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "getAcademyKioskSettings");
      const res = await fn({ academyId: aid });
      const data = res.data as { settings?: AcademyKioskSettingsPublic };
      setKioskSettings(data.settings ?? null);
    } catch {
      setKioskSettings(null);
    }
  }, []);

  useEffect(() => {
    if (!academyId || gate !== "ready") return;
    void loadKioskSettings(academyId);
    try {
      const on = sessionStorage.getItem(kioskModeStorageKey(academyId)) === "1";
      setKioskMode(on);
    } catch {
      setKioskMode(false);
    }
  }, [academyId, gate, loadKioskSettings]);

  useEffect(() => {
    if (!academyId || gate !== "ready") return;
    const syncKioskFromStorage = () => {
      try {
        setKioskMode(sessionStorage.getItem(kioskModeStorageKey(academyId)) === "1");
      } catch {
        setKioskMode(false);
      }
    };
    syncKioskFromStorage();
    window.addEventListener("focus", syncKioskFromStorage);
    return () => window.removeEventListener("focus", syncKioskFromStorage);
  }, [academyId, gate]);

  useEffect(() => {
    if (!academyId || gate !== "ready") return;
    if (!isKioskModeActive(academyId)) {
      sectionExitPromptedRef.current = false;
      return;
    }
    const sec = parseSection(searchParams.get("section"));
    if (sec === "home") {
      sectionExitPromptedRef.current = false;
      return;
    }
    if (sectionExitPromptedRef.current) return;
    sectionExitPromptedRef.current = true;
    pendingSectionAfterExitRef.current = sec;
    setKioskExitPinError(null);
    setKioskExitPinOpen(true);
    const p = new URLSearchParams(searchParams.toString());
    p.delete("section");
    const qs = p.toString();
    router.replace(qs ? `/academy?${qs}` : "/academy", { scroll: false });
  }, [academyId, gate, router, searchParams]);

  useEffect(() => {
    if (!academyId || !kioskMode) return;
    let cancelled = false;
    setKioskRowsBusy(true);
    void loadKioskStudentRows(academyId)
      .then((rows) => {
        if (!cancelled) setKioskRows(rows);
      })
      .catch(() => {
        if (!cancelled) setKioskRows([]);
      })
      .finally(() => {
        if (!cancelled) setKioskRowsBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [academyId, kioskMode]);

  const persistKioskMode = useCallback((aid: string, on: boolean) => {
    try {
      if (on) sessionStorage.setItem(kioskModeStorageKey(aid), "1");
      else sessionStorage.removeItem(kioskModeStorageKey(aid));
    } catch {
      /* ignore */
    }
    setKioskMode(on);
  }, []);

  const callableMsg = (err: unknown, fallback: string) =>
    err instanceof FirebaseError && err.message ? err.message : fallback;

  const requestKioskOn = useCallback(() => {
    if (!kioskSettings?.exitPinConfigured) {
      setKioskToast("학원 설정에서 키오스크 종료 PIN을 먼저 설정해 주세요.");
      return;
    }
    if (kioskSettings.exitPinLocked) {
      setKioskToast("종료 PIN이 잠겼습니다. 학원 설정에서 잠금을 해제해 주세요.");
      return;
    }
    setKioskEnableConfirmOpen(true);
  }, [kioskSettings]);

  const confirmKioskOn = useCallback(() => {
    if (!academyId) return;
    setKioskEnableConfirmOpen(false);
    persistKioskMode(academyId, true);
    setKioskToast(null);
  }, [academyId, persistKioskMode]);

  const requestKioskOff = useCallback(() => {
    if (!academyId) return;
    if (!kioskSettings?.exitPinConfigured) {
      persistKioskMode(academyId, false);
      return;
    }
    setKioskExitPinError(null);
    setKioskExitPinOpen(true);
  }, [academyId, kioskSettings?.exitPinConfigured, persistKioskMode]);

  const verifyExitPinAndOff = useCallback(
    async (pin: string) => {
      if (!academyId) return;
      setKioskActionBusy(true);
      setKioskExitPinError(null);
      try {
        await verifyKioskExitPinAndClear(academyId, pin);
        persistKioskMode(academyId, false);
        setKioskExitPinOpen(false);
        const pendingSection = pendingSectionAfterExitRef.current;
        pendingSectionAfterExitRef.current = null;
        sectionExitPromptedRef.current = false;
        if (pendingSection && pendingSection !== "home") {
          const p = new URLSearchParams(searchParams.toString());
          p.set("section", pendingSection);
          router.replace(`/academy?${p.toString()}`, { scroll: false });
        }
        void loadKioskSettings(academyId);
      } catch (err) {
        setKioskExitPinError(callableMsg(err, "PIN 확인에 실패했습니다."));
        void loadKioskSettings(academyId);
      } finally {
        setKioskActionBusy(false);
      }
    },
    [academyId, loadKioskSettings, persistKioskMode, router, searchParams],
  );

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
      router.replace("/login/academy");
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

  const onBackToOwner = useCallback(() => {
    // 오너 대시보드에서 진입한 경우엔 히스토리 복귀가 가장 저부하.
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
      return;
    }
    router.push("/owner");
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

  const loadDashboardStatsFallback = useCallback(async () => {
    if (gate !== "ready" || !academyId) return;
    const db = getFirebaseDb();
    const sub = (name: "teachers" | "parents" | "students") =>
      collection(db, COLLECTIONS.academies, academyId, name);
    try {
      const [teachersSnap, parentsSnap, studentsSnap, stu, tp, tiNeed, tiSent, pp, piNeed, piSent] =
        await Promise.all([
          getCountFromServer(sub("teachers")),
          getCountFromServer(sub("parents")),
          getCountFromServer(sub("students")),
          getCountFromServer(sub("students")),
          getCountFromServer(
            query(sub("teachers"), where("status", "==", "pending_registration")),
          ),
          getCountFromServer(
            query(sub("teachers"), where("status", "==", "invitation_needed")),
          ),
          getCountFromServer(query(sub("teachers"), where("status", "==", "invitation_sent"))),
          getCountFromServer(
            query(sub("parents"), where("status", "==", "pending_registration")),
          ),
          getCountFromServer(
            query(sub("parents"), where("status", "==", "invitation_needed")),
          ),
          getCountFromServer(query(sub("parents"), where("status", "==", "invitation_sent"))),
        ]);
      const heatmap: AcademyHeatmapCounts = {
        students: stu.data().count,
        teachersPending: tp.data().count,
        teachersInviteNeeded: tiNeed.data().count,
        teachersInviteSent: tiSent.data().count,
        parentsPending: pp.data().count,
        parentsInviteNeeded: piNeed.data().count,
        parentsInviteSent: piSent.data().count,
      };
      setSummaryCounts({
        teachers: teachersSnap.data().count,
        parents: parentsSnap.data().count,
        students: studentsSnap.data().count,
      });
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
  }, [gate, academyId]);

  const loadDashboardStats = useCallback(async () => {
    if (gate !== "ready" || !academyId) return;
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
  }, [gate, academyId, loadDashboardStatsFallback]);

  useEffect(() => {
    if (gate !== "ready" || !academyId) {
      setSummaryCounts(null);
      setSummaryCountsError(null);
      return;
    }
    void loadDashboardStats();
  }, [gate, academyId, loadDashboardStats]);

  useEffect(() => {
    if (gate !== "ready" || !academyId) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void loadDashboardStats();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [gate, academyId, loadDashboardStats]);

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
    <div className={`min-h-[100dvh] bg-background ${kioskMode ? "pb-6" : "pb-28"}`}>
      <DashboardRoleHeader
        title={kioskMode ? "출석 키오스크" : "학원 대시보드"}
        affiliationLabel={academyLabelForGreeting(academyName, academyId)}
        includeSettingsAction={!kioskMode}
        onSettingsAction={
          kioskMode
            ? undefined
            : () => router.push(`/academy/settings?id=${encodeURIComponent(academyId)}`)
        }
        settingsLabel="학원 설정"
        beforeBell={
          <div className="flex items-center gap-2">
            <SlideSwitch
              checked={kioskMode}
              disabled={kioskActionBusy}
              ariaLabel="출석 키오스크"
              onCheckedChangeAction={(next) => {
                if (next) requestKioskOn();
                else requestKioskOff();
              }}
            />
          </div>
        }
        menuIntro={
          showBack && !kioskMode ? (
            <span className="text-neutral-600 dark:text-neutral-400">
              오너 계정에서 이 학원 대시보드를 보고 있어요.
            </span>
          ) : undefined
        }
        showBack={showBack && !kioskMode}
        hideBottomNav={kioskMode}
        onBackAction={onBackToOwner}
        backAriaLabel="오너 대시보드로 돌아가기"
        onHomeAction={() => router.push("/")}
        showBellOnTitle
        showBellInBottomBar={false}
        onBellClickAction={() => setNotificationsOpen(true)}
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
          {
            id: "notifications",
            label: "알림 기록",
            icon: (active: boolean) => <IconBellMini active={active} />,
            active: section === "notifications",
            onSelect: () => navigateSection("notifications"),
          },
        ]}
        onLogoutAction={
          isAcademyPortalSession
            ? () => void onPortalLogout()
            : () => void onHeaderLogout()
        }
        logoutBusy={logoutBusy}
        profile={authProfile}
      />

      {kioskToast ? (
        <p className="mx-auto max-w-lg px-4 pt-2 text-center text-xs text-red-600 dark:text-red-400">
          {kioskToast}
        </p>
      ) : null}

      {kioskEnableConfirmOpen ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-xl dark:bg-neutral-900">
            <p className="text-lg font-semibold text-foreground">출석 키오스크</p>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              키오스크 모드에서는 학생 검색 후 출석만 처리할 수 있습니다. 계속할까요?
            </p>
            <div className="mt-6 flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium dark:border-white/15"
                onClick={() => setKioskEnableConfirmOpen(false)}
              >
                취소
              </button>
              <button
                type="button"
                className="flex-1 rounded-2xl bg-[#222] py-3 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950"
                onClick={confirmKioskOn}
              >
                켜기
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <PinPadModal
        open={kioskExitPinOpen}
        phaseKey={kioskExitPinOpen ? "exit" : "exit-closed"}
        title="키오스크 종료 PIN"
        description="키오스크를 끄려면 종료 PIN 4자리를 입력해 주세요."
        error={kioskExitPinError}
        busy={kioskActionBusy}
        busyTitle="키오스크 종료 중..."
        busyDescription="잠시만 기다려 주세요."
        onCloseAction={() => {
          if (!kioskActionBusy) {
            setKioskExitPinOpen(false);
            setKioskExitPinError(null);
            pendingSectionAfterExitRef.current = null;
            sectionExitPromptedRef.current = false;
          }
        }}
        onCompleteAction={(pin) => void verifyExitPinAndOff(pin)}
      />

      <main className="mx-auto max-w-lg px-4 pt-4">
        {kioskMode ? (
          <section className="mt-2">
            <AcademyKioskPanel
              academyId={academyId}
              requireStudentCheckInPin={
                kioskSettings?.requireStudentCheckInPin ?? false
              }
              rows={kioskRowsBusy ? [] : kioskRows}
            />
          </section>
        ) : (
          <>
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

        {section === "notifications" ? (
          <section className="mt-6">
            <AcademyAttendanceLogPanel
              academyId={academyId}
              storageScopeKey={`academy_${academyId}`}
            />
          </section>
        ) : null}
          </>
        )}
      </main>

      <DashboardNotificationsModal
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
        heading="알림"
        items={academyBellItems}
        emptyLabel={academyBellError ?? "표시할 알림이 없습니다."}
        onDeleteItem={dismissAcademyBellOne}
        onDeleteAll={dismissAcademyBellAll}
      />

      <DashboardBottomScrim />
    </div>
  );
}
