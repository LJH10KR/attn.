"use client";

import { AcademyParentPanel } from "@/components/academy/academy-parent-panel";
import { AcademyStudentPanel } from "@/components/academy/academy-student-panel";
import { AcademyTeacherPanel } from "@/components/academy/academy-teacher-panel";
import { AcademyTreemap, type AcademyHeatmapItem } from "@/components/academy/academy-treemap";
import { COLLECTIONS, type Academy } from "@/lib/firebase/attn-schema";
import { signOut } from "firebase/auth";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { doc, getDoc } from "firebase/firestore";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

const glassCard = "glass-card";

type AcademySection = "home" | "teachers" | "parents" | "students";

function parseSection(raw: string | null): AcademySection {
  if (raw === "teachers" || raw === "parents" || raw === "students") {
    return raw;
  }
  return "home";
}

/** 목업과 동일한 분포·라벨. 이후 API·Firestore 집계로 교체 예정 */
const PLACEHOLDER_HEATMAP: AcademyHeatmapItem[] = [
  { id: "attendance", label: "출근 처리 요청", value: 10, score: -0.72, metric: "10건" },
  { id: "teachers-pending", label: "등록 대기 중 선생님", value: 2, score: -0.15, metric: "2명" },
  { id: "teachers-invite", label: "초청 필요 선생님", value: 1, score: -0.35, metric: "1명" },
  { id: "parents-pending", label: "등록 대기 중 학부모", value: 5, score: -0.12, metric: "5명" },
  { id: "parents-invite", label: "초청 필요 학부모", value: 7, score: -0.55, metric: "7명" },
];

const STAT_COUNTS = [
  { key: "teachers" as const, label: "선생님", value: "7" },
  { key: "parents" as const, label: "학부모", value: "30" },
  { key: "students" as const, label: "학생", value: "70" },
];

function BellIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3a6 6 0 00-6 6v2.4L4 14v1h16v-1l-2-2.6V9a6 6 0 00-6-6z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9 19a3 3 0 006 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconHome({ active }: { active?: boolean }) {
  const stroke = active ? "#fff" : "#444";
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 10.5L12 4l8 6.5V20a1 1 0 01-1 1h-5v-6H10v6H5a1 1 0 01-1-1v-9.5z"
        stroke={stroke}
        strokeWidth="1.7"
        strokeLinejoin="round"
        fill={active ? "rgba(255,255,255,0.2)" : "none"}
      />
    </svg>
  );
}

function IconMonitor({ active }: { active?: boolean }) {
  const stroke = active ? "#fff" : "#666";
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
        fill={active ? "rgba(255,255,255,0.15)" : "none"}
      />
      <path d="M8 19h8M12 16v3" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconPerson({ active }: { active?: boolean }) {
  const stroke = active ? "#fff" : "#666";
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
  const stroke = active ? "#fff" : "#666";
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M8 7V6a4 4 0 018 0v1" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
      <rect
        x="5"
        y="7"
        width="14"
        height="13"
        rx="3"
        stroke={stroke}
        strokeWidth="1.6"
        fill={active ? "rgba(255,255,255,0.12)" : "none"}
      />
      <path d="M12 11v4" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function AcademyDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const configured = isFirebaseConfigured();

  const [gate, setGate] = useState<"loading" | "ready" | "forbidden" | "auth">("loading");
  const [academyId, setAcademyId] = useState<string | null>(null);
  const [academyName, setAcademyName] = useState<string | null>(null);
  const [showBack, setShowBack] = useState(false);
  /** 학원 ID·비밀번호 포털 로그인(커스텀 토큰) 세션 — 오너 대시보드에서 연 경로와 구분 */
  const [isAcademyPortalSession, setIsAcademyPortalSession] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);

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
    const portalAcademyId = typeof claims.academyId === "string" ? claims.academyId : "";

    if (isPortal && portalAcademyId) {
      setAcademyId(portalAcademyId);
      setShowBack(false);
      setIsAcademyPortalSession(true);
      try {
        const snap = await getDoc(doc(getFirebaseDb(), COLLECTIONS.academies, portalAcademyId));
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
        const snap = await getDoc(doc(getFirebaseDb(), COLLECTIONS.academies, queryAcademyId));
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
        <Link href="/login" className="text-xs text-neutral-500 underline-offset-2 hover:underline">
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
    <div className="min-h-[100dvh] bg-background pb-28 pt-[env(safe-area-inset-top)]">
      <header
        className={`sticky top-0 z-10 mx-auto max-w-lg px-4 pt-4 pb-2 ${glassCard}`}
        style={{ WebkitBackdropFilter: "blur(20px)" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
              attn.
            </p>
            {showBack ? (
              <button
                type="button"
                onClick={() => router.push("/owner")}
                className="mt-2 flex h-10 w-10 items-center justify-center rounded-full border border-neutral-300/60 bg-white/55 text-foreground shadow-sm backdrop-blur-md hover:bg-white/85"
                aria-label="오너 대시보드로 돌아가기"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M15 6l-6 6 6 6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : (
              <div className="mt-2 h-10 w-10" aria-hidden />
            )}
          </div>
          <div className="mt-1 flex shrink-0 items-center gap-2">
            {isAcademyPortalSession ? (
              <button
                type="button"
                onClick={() => void onPortalLogout()}
                disabled={logoutBusy}
                className="rounded-full border border-neutral-300/50 bg-white/45 px-3 py-2 text-[11px] font-medium text-neutral-800 backdrop-blur-md hover:bg-white/75 disabled:opacity-50"
              >
                {logoutBusy ? "…" : "로그아웃"}
              </button>
            ) : null}
            <button
              type="button"
              className="flex h-10 w-10 items-center justify-center rounded-full border border-neutral-300/50 bg-white/45 text-neutral-700 backdrop-blur-md hover:bg-white/75"
              aria-label="알림"
            >
              <BellIcon className="text-neutral-700" />
            </button>
          </div>
        </div>
        <h1 className="-mt-2 pb-1 text-center text-lg font-semibold text-foreground">학원 대시보드</h1>
        {academyName ? (
          <p className="pb-2 text-center text-xs text-neutral-500 truncate px-2">{academyName}</p>
        ) : (
          <p className="pb-2 text-center font-mono text-[10px] text-neutral-400 truncate px-2">
            {academyId}
          </p>
        )}
      </header>

      <main className="mx-auto max-w-lg px-4 pt-5">
        <div className="grid grid-cols-3 gap-2">
          {STAT_COUNTS.map((c) => {
            const isActive = section === c.key;
            const isHomeCards = section === "home";
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
                    isActive ? "text-white/90 dark:text-neutral-600" : "text-neutral-500 dark:text-neutral-400"
                  }`}
                >
                  {c.label}
                </span>
                <span
                  className={`mt-1 text-xl font-semibold tabular-nums ${
                    isActive ? "text-white dark:text-neutral-950" : "text-foreground"
                  }`}
                >
                  {c.value}
                </span>
              </button>
            );
          })}
        </div>

        {section === "home" ? (
          <section className="mt-6">
            <h2 className="mb-3 text-sm font-semibold text-foreground">히트맵</h2>
            <div className={`p-4 ${glassCard}`}>
              <AcademyTreemap items={PLACEHOLDER_HEATMAP} />
              <p className="mt-3 text-[10px] leading-relaxed text-neutral-500">
                타일 면적은 건수(볼륨), 색상은 상태 지표를 나타냅니다. 실제 지표는 추후 연동됩니다.
              </p>
            </div>
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

      <nav
        className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-20 w-[min(100%,22rem)] -translate-x-1/2 px-4"
        aria-label="학원 메인 메뉴"
      >
        <div className="glass-dock flex items-center justify-between gap-1 rounded-full px-3 py-2.5">
          {(
            [
              { id: "home" as const, label: "홈", icon: IconHome },
              { id: "teachers" as const, label: "선생님", icon: IconMonitor },
              { id: "parents" as const, label: "학부모", icon: IconPerson },
              { id: "students" as const, label: "학생", icon: IconBackpack },
            ] as const
          ).map((item) => {
            const active = section === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateSection(item.id)}
                className={`flex flex-1 flex-col items-center gap-0.5 rounded-2xl py-1 transition ${
                  active
                    ? "bg-[#222] text-white shadow-inner dark:bg-neutral-100 dark:text-neutral-950"
                    : "text-neutral-600 opacity-75 dark:text-neutral-400"
                }`}
              >
                <span className="flex h-9 w-9 items-center justify-center">
                  <Icon active={active} />
                </span>
                <span className="text-[9px] font-medium">{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
