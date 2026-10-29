"use client";

import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AcademyKioskPanel } from "@/components/academy/academy-kiosk-panel";
import { AcademyTabIcon } from "@/components/academy/academy-tab-icons";
import { KioskExitPinGate } from "@/components/academy/kiosk-exit-pin-gate";
import { KioskHistoryGuard } from "@/components/academy/kiosk-history-guard";
import { useAcademyKiosk, type AcademyKioskState } from "@/components/academy/use-academy-kiosk";
import { closesBootOverlayItself, useBootOverlay } from "@/components/boot/boot-overlay";
import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";
import { DashboardNotificationsModal } from "@/components/dashboard/dashboard-notifications-modal";
import { DashboardRoleHeader } from "@/components/dashboard/dashboard-role-header";
import { SlideSwitch } from "@/components/ui/slide-switch";
import {
  ACADEMY_TAB_MENUS,
  ACADEMY_TAB_SHORT_LABELS,
  academyPath,
  resolveAcademyRoute,
  type AcademyTab,
} from "@/lib/academy/academy-routes";
import { rememberLastAcademy } from "@/lib/academy/last-academy";
import type { AcademyPermission } from "@/lib/academy/permissions";
import { resolveStaffLanding } from "@/lib/academy/staff-landing";
import { usePermissions, type AcademyPermissionState } from "@/lib/academy/use-permissions";
import { useRoleLogout } from "@/lib/auth/use-role-logout";
import { COLLECTIONS } from "@/lib/firebase/attn-schema";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { useAcademyDashboardBell } from "@/lib/firebase/use-academy-dashboard-bell";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";
import { academyLabelForGreeting } from "@/lib/ui/dashboard-greetings";

export type AcademyShellValue = {
  academyId: string;
  academyName: string | null;
  permissions: AcademyPermissionState;
  /** 이 학원 아래 주소 — `href("operations/students")` */
  href: (sub?: string) => string;
  kiosk: AcademyKioskState;
};

const AcademyShellContext = createContext<AcademyShellValue | null>(null);

/** `/academy/[academyId]` 아래 화면에서 학원 ID·권한·키오스크를 받는다 */
export function useAcademyShell(): AcademyShellValue {
  const value = useContext(AcademyShellContext);
  if (!value) throw new Error("useAcademyShell은 학원 공통 레이아웃 안에서만 쓸 수 있습니다.");
  return value;
}

function CenterMessage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center gap-4 px-4">
      {children}
    </div>
  );
}

function Loading() {
  return (
    <CenterMessage>
      <p className="text-sm text-neutral-500">불러오는 중…</p>
    </CenterMessage>
  );
}

/** 알림 벨(adminInbox) 읽기 권한 — 보안 규칙과 같은 목록 */
const BELL_PERMISSIONS: readonly AcademyPermission[] = [
  "settings.members",
  "operations.parents",
  "billing.payments",
];

/**
 * 이 학원의 멤버로 보이지 않을 때(비활성·퇴사·계정 삭제·아직 활성 전) 갈 곳 — 본인 학원 직원만.
 * 다른 학원 주소·학부모 등은 null(권한 없음 화면).
 */
async function landingForMissingActor(user: User, academyId: string): Promise<string | null> {
  try {
    const { claims } = await user.getIdTokenResult();
    if (claims.role !== "teacher" || claims.academyId !== academyId) return null;
    // 선생님 화면은 클레임의 "active"를 믿으므로 먼저 토큰을 새로 받는다 — 비활성·삭제·비밀번호 초기화면 실패
    try {
      await user.getIdToken(true);
    } catch {
      await signOut(getFirebaseAuth()).catch(() => undefined);
      return "/login/teacher";
    }
    const target = await resolveStaffLanding(user, academyId);
    const here = academyPath(academyId);
    // 다시 이 학원이면(권한 구독 오류 등) 이동하지 않음 — 같은 주소로 되풀이 이동 방지
    return target === here || target.startsWith(`${here}/`) ? null : target;
  } catch {
    return null;
  }
}

function BackChevronIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * 학원 공통 레이아웃 — 학원 정보·권한(usePermissions 한 번)·헤더(화면 제목·뒤로가기)·하단 5탭·키오스크 잠금.
 * 화면 노출만 정하고, 실제 차단은 보안 규칙과 서버 `assertPermission`이 한다.
 */
export function AcademyShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ academyId: string }>();
  const academyId = params.academyId ?? "";
  const route = resolveAcademyRoute(pathname);
  const configured = isFirebaseConfigured();
  const { profile: authProfile } = useAuthProfile();

  const [authUser, setAuthUser] = useState<User | null | undefined>(undefined);
  const [academyName, setAcademyName] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  const { hide: hideBootOverlay } = useBootOverlay();
  const permissions = usePermissions(academyId);
  const { actor, can, visibleTabs } = permissions;
  /** 볼 수 있는 메뉴가 하나도 없는 직원(기본 "선생님") — 선생님 화면 사용 */
  const staffWithoutMenus = actor === "staff" && visibleTabs.length === 0;
  // 키오스크 체크인·종료 PIN 확인은 서버가 출결 권한만 허용 — 켜기도 출결 권한일 때만
  const kiosk = useAcademyKiosk(academyId, actor !== null && can("lessons.attendance"));
  const canBell = can(BELL_PERMISSIONS);

  /** 멤버로 보이지 않을 때의 착지 판단 — actor가 null이 될 때마다 한 번만 */
  const landingKey = authUser ? `${authUser.uid}|${academyId}` : null;
  const landingKeyRef = useRef<string | null>(null);
  const [forbiddenKey, setForbiddenKey] = useState<string | null>(null);
  const actorMissing = Boolean(authUser) && !permissions.loading && actor === null;

  const {
    items: bellItems,
    count: bellCount,
    error: bellError,
    dismissOne: dismissBellOne,
    dismissAllVisible: dismissBellAll,
    refresh: refreshBell,
  } = useAcademyDashboardBell(actor && !staffWithoutMenus && canBell ? academyId : null);

  const { logout, logoutBusy, logoutModal } = useRoleLogout({
    redirectTo: "/login",
    role: "generic",
    extraBadgeUserIds: [`academy:${academyId}`],
  });

  useEffect(() => {
    if (!configured) return;
    return onAuthStateChanged(getFirebaseAuth(), (user) => setAuthUser(user));
  }, [configured]);

  useEffect(() => {
    if (!authUser || !academyId) return;
    let cancelled = false;
    void getDoc(doc(getFirebaseDb(), COLLECTIONS.academies, academyId))
      .then((snap) => {
        const name = snap.get("name");
        if (!cancelled) setAcademyName(typeof name === "string" ? name : null);
      })
      .catch(() => {
        if (!cancelled) setAcademyName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [authUser, academyId]);

  useEffect(() => {
    if (actor === "owner" && authUser) rememberLastAcademy(authUser.uid, academyId);
  }, [actor, authUser, academyId]);

  useEffect(() => {
    if (staffWithoutMenus) router.replace("/teacher");
  }, [staffWithoutMenus, router]);

  useEffect(() => {
    if (actor) {
      landingKeyRef.current = null;
      return;
    }
    if (!actorMissing || !authUser || !landingKey || landingKeyRef.current === landingKey) return;
    landingKeyRef.current = landingKey;
    void landingForMissingActor(authUser, academyId).then((target) => {
      if (landingKeyRef.current !== landingKey) return;
      if (!target) {
        setForbiddenKey(landingKey);
        return;
      }
      if (!closesBootOverlayItself(target)) hideBootOverlay();
      router.replace(target);
    });
  }, [actor, actorMissing, authUser, landingKey, academyId, router, hideBootOverlay]);

  // 콜드 부팅 오버레이 — 보여 줄 화면이 정해지면 닫는다(다른 화면으로 보내는 중이면 그 화면이 닫음)
  const screenReady =
    !configured ||
    authUser === null ||
    (authUser !== undefined && Boolean(kiosk.activeAcademyId)) ||
    (!permissions.loading &&
      !staffWithoutMenus &&
      (actor !== null || (landingKey !== null && forbiddenKey === landingKey)));
  useEffect(() => {
    if (screenReady) hideBootOverlay();
  }, [screenReady, hideBootOverlay]);

  useEffect(() => {
    if (notificationsOpen) refreshBell();
  }, [notificationsOpen, refreshBell]);

  useEffect(() => {
    refreshBell();
  }, [pathname, refreshBell]);

  if (!configured) {
    return (
      <CenterMessage>
        <p className="text-sm text-neutral-600">Firebase 설정이 필요합니다.</p>
      </CenterMessage>
    );
  }

  if (authUser === undefined) return <Loading />;

  if (authUser === null) {
    return (
      <CenterMessage>
        <p className="text-sm text-neutral-600">로그인이 필요합니다.</p>
        <Link
          href="/login"
          className="rounded-2xl bg-[#222] px-6 py-3 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950"
        >
          로그인
        </Link>
      </CenterMessage>
    );
  }

  const affiliationLabel = academyLabelForGreeting(academyName, academyId);

  // 키오스크 중에는 그 학원 홈(키오스크 화면)만 — 다른 학원 경로·다른 학원 ID는 종료 PIN을 거친다
  const kioskAcademyId = kiosk.activeAcademyId;
  if (kioskAcademyId) {
    if (kioskAcademyId !== academyId || route?.tab !== "home") {
      return (
        <KioskExitPinGate key={pathname} academyId={kioskAcademyId} cancelHref={academyPath(kioskAcademyId)}>
          {null}
        </KioskExitPinGate>
      );
    }
    return (
      <div className="min-h-[100dvh] bg-background pb-6">
        <KioskHistoryGuard academyId={academyId} />
        <DashboardRoleHeader
          title="출석 키오스크"
          affiliationLabel={affiliationLabel}
          profile={authProfile}
          hideBottomNav
          showBell={false}
          showProfile={false}
          beforeBell={
            <SlideSwitch
              checked
              disabled={kiosk.busy}
              ariaLabel="키오스크 모드 종료"
              onCheckedChangeAction={kiosk.requestOff}
            />
          }
          onLogoutAction={() => undefined}
        />
        <main className="mx-auto max-w-lg px-4 pt-[26px]">
          <section className="mt-2">
            <AcademyKioskPanel
              academyId={academyId}
              requireStudentCheckInPin={kiosk.settings?.requireStudentCheckInPin ?? false}
              rows={kiosk.rowsBusy ? [] : kiosk.rows}
            />
          </section>
        </main>
        {kiosk.modals}
        <DashboardBottomScrim />
      </div>
    );
  }

  if (permissions.loading || staffWithoutMenus) return <Loading />;

  if (!actor) {
    // 착지 판단 중이거나 다른 화면으로 보내는 중
    if (forbiddenKey !== landingKey) return <Loading />;
    return (
      <CenterMessage>
        <p className="max-w-xs text-center text-sm text-neutral-600">
          이 학원에 접근할 권한이 없거나 주소가 올바르지 않습니다.
        </p>
        <Link
          href="/academy"
          className="rounded-2xl border border-neutral-300/70 bg-white/60 px-6 py-3 text-sm font-medium text-foreground dark:border-white/12 dark:bg-white/10"
        >
          내 학원으로
        </Link>
        <Link href="/login" className="text-xs text-neutral-500 underline-offset-2 hover:underline">
          로그인
        </Link>
      </CenterMessage>
    );
  }

  const value: AcademyShellValue = {
    academyId,
    academyName,
    permissions,
    href: (sub = "") => academyPath(academyId, sub),
    kiosk,
  };
  const allowed = !route?.required || can(route.required);
  const tabs: AcademyTab[] = ["home", ...visibleTabs];
  const backTitle = route?.backSub
    ? ACADEMY_TAB_MENUS.find((t) => t.tab === route.backSub)?.title ?? null
    : null;
  // 상세 화면 권한만 빠졌으면 그 탭 요약으로, 탭 자체가 사라졌으면 홈으로
  const forbiddenBackToTab = Boolean(route?.backSub) && visibleTabs.some((t) => t === route?.tab);

  return (
    <AcademyShellContext.Provider value={value}>
      <div className="min-h-[100dvh] bg-background pb-28">
        <DashboardRoleHeader
          title={route?.title ?? "학원 홈"}
          affiliationLabel={affiliationLabel}
          profile={authProfile}
          onHomeAction={() => router.push("/")}
          showBell={canBell}
          onBellClickAction={() => setNotificationsOpen(true)}
          bellBadgeCount={bellCount}
          extraMenuActions={[
            {
              label: "내 계정",
              onSelectAction: () => router.push(actor === "owner" ? "/owner/settings" : "/teacher/settings"),
            },
            actor === "owner"
              ? { label: "오너 대시보드", onSelectAction: () => router.push("/owner") }
              : // 수업도 맡는 직원 — 담당 학생 목록·알림 보내기
                { label: "선생님 화면", onSelectAction: () => router.push("/teacher") },
          ]}
          bottomTabs={tabs.map((t) => ({
            id: t,
            label: ACADEMY_TAB_SHORT_LABELS[t],
            iconAction: (active: boolean) => <AcademyTabIcon tab={t} active={active} />,
            active: route?.tab === t,
            onSelectAction: () => router.push(academyPath(academyId, t === "home" ? "" : t)),
          }))}
          onLogoutAction={() => void logout()}
          logoutBusy={logoutBusy}
        />

        <main className="mx-auto max-w-lg px-4 pt-[26px]">
          {route?.title ? (
            <div className="mb-4 flex items-center gap-2">
              {route.backSub ? (
                <button
                  type="button"
                  onClick={() => router.push(academyPath(academyId, route.backSub ?? ""))}
                  className="-ml-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-foreground transition hover:bg-black/[0.05] dark:hover:bg-white/10"
                  aria-label={backTitle ? `${backTitle}로` : "뒤로 가기"}
                >
                  <BackChevronIcon />
                </button>
              ) : null}
              <h1 className="min-w-0 truncate text-lg font-semibold text-foreground">{route.title}</h1>
            </div>
          ) : null}

          {kiosk.toast ? (
            <p className="mb-3 text-center text-xs text-red-600 dark:text-red-400">{kiosk.toast}</p>
          ) : null}

          {allowed ? (
            children
          ) : (
            <div className="glass-card px-4 py-12 text-center">
              <p className="text-sm text-neutral-600">이 화면을 볼 권한이 없습니다.</p>
              <Link
                href={academyPath(academyId, forbiddenBackToTab ? (route?.backSub ?? "") : "")}
                className="mt-3 inline-block text-sm underline"
              >
                {forbiddenBackToTab ? "탭 요약으로" : "홈으로"}
              </Link>
            </div>
          )}
        </main>

        {kiosk.modals}

        <DashboardNotificationsModal
          open={notificationsOpen}
          onClose={() => setNotificationsOpen(false)}
          heading="알림"
          items={bellItems}
          emptyLabel={bellError ?? "표시할 알림이 없습니다."}
          onDeleteItem={dismissBellOne}
          onDeleteAll={dismissBellAll}
        />

        <DashboardBottomScrim />
        {logoutModal}
      </div>
    </AcademyShellContext.Provider>
  );
}
