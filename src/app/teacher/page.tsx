"use client";

import { FirebaseError } from "firebase/app";
import { onAuthStateChanged } from "firebase/auth";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StudentDetailSheet } from "@/components/academy/student-detail/student-detail-sheet";
import { useStudentDetailParam } from "@/components/academy/student-detail/use-student-detail-param";
import { groupMyClasses, TeacherMyClasses } from "@/components/teacher/teacher-my-classes";
import type { ClassAttendanceAction } from "@/components/academy/attendance/class-attendance-controls";
import { HomeTabIcon } from "@/components/dashboard/attn-tab-logo";
import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";
import { DashboardNotificationsModal } from "@/components/dashboard/dashboard-notifications-modal";
import { DashboardRoleHeader } from "@/components/dashboard/dashboard-role-header";
import { RoleDashboardBootShell } from "@/components/dashboard/role-dashboard-boot-shell";
import { StudentListSectionSkeleton } from "@/components/dashboard/student-list-section-skeleton";
import {
  getFirebaseAuth,
  getFirebaseDb,
} from "@/lib/firebase/client-app";
import { useAttendanceNotificationLog } from "@/lib/firebase/use-attendance-notification-log";
import { academyPath } from "@/lib/academy/academy-routes";
import { staffDocHasAcademyMenus } from "@/lib/academy/staff-landing";
import { docToStudent, type StudentVM } from "@/lib/academy/student-row";
import { docToClassBrief, type AcademyClassBrief } from "@/lib/academy/use-academy-classes";
import { useAcademyOptionList } from "@/lib/academy/use-academy-option-list";
import { usePermissions } from "@/lib/academy/use-permissions";
import { useAttendanceActions } from "@/lib/academy/use-attendance-actions";
import { useSeoulToday } from "@/lib/academy/use-class-today-attendance";
import { academyStudentsPath, COLLECTIONS } from "@/lib/firebase/attn-schema";
import { setLastDashboardRoleHint } from "@/lib/auth/last-dashboard-role";
import { useBootOverlay } from "@/components/boot/boot-overlay";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";
import { resolveTeacherActivationState } from "@/lib/firebase/resolve-session-dashboard";
import { useRoleLogout } from "@/lib/auth/use-role-logout";
import { buildDashboardHeaderProfile } from "@/lib/ui/dashboard-header-profile";
import { academyLabelForGreeting } from "@/lib/ui/dashboard-greetings";

const glassCard = "glass-card";

type MyClassesData = { students: StudentVM[]; classes: AcademyClassBrief[] };

/**
 * 내 반·담당 학생 — 클라이언트 쿼리(규칙: 활성 선생님 + `teacherUids`에 본인).
 * 학생 `teacherUids`는 반(종강 제외)에서 서버가 계산하고, 반 문서의 `teacherUids`는 반 선생님 그대로.
 */
async function loadMyClasses(academyId: string, uid: string): Promise<MyClassesData> {
  const db = getFirebaseDb();
  const [studentSnap, classSnap] = await Promise.all([
    getDocs(query(collection(db, academyStudentsPath(academyId)), where("teacherUids", "array-contains", uid))),
    getDocs(
      query(
        collection(db, COLLECTIONS.academies, academyId, "classes"),
        where("teacherUids", "array-contains", uid),
      ),
    ),
  ]);
  return {
    students: studentSnap.docs.map((d) => docToStudent(d.id, d.data() as Record<string, unknown>)),
    classes: classSnap.docs.map((d) => docToClassBrief(d.id, d.data() as Record<string, unknown>)),
  };
}

/** 규칙 거부(계정 비활성·권한 변경)와 네트워크 오류를 나눠 안내 */
function myClassesErrorMessage(err: unknown): string {
  const code = err instanceof FirebaseError ? err.code : "";
  if (code === "permission-denied") {
    return "담당 반 정보를 볼 수 없습니다. 계정이 비활성화되었거나 학원에서 권한이 바뀌었을 수 있습니다.";
  }
  if (code === "unavailable" || code === "deadline-exceeded" || (typeof navigator !== "undefined" && !navigator.onLine)) {
    return "네트워크 연결을 확인한 뒤 목록 새로고침을 눌러 주세요.";
  }
  return "담당 학생 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

export default function TeacherDashboardPage() {
  return (
    <Suspense
      fallback={
        <RoleDashboardBootShell
          loadingLabel="선생님 대시보드 확인 중"
          footerHint="선생님 계정과 연결 정보를 확인하는 중입니다."
        />
      }
    >
      <TeacherDashboard />
    </Suspense>
  );
}

function TeacherDashboard() {
  const router = useRouter();
  const { hide: hideBootOverlay } = useBootOverlay();
  const { profile: authProfile } = useAuthProfile();
  const [ready, setReady] = useState(false);
  const [academyId, setAcademyId] = useState<string | null>(null);
  const [academyName, setAcademyName] = useState<string | null>(null);
  const [memberPhone, setMemberPhone] = useState<string | null>(null);
  const [memberDisplayName, setMemberDisplayName] = useState<string | null>(null);
  const [googleLinked, setGoogleLinked] = useState(false);
  const [googleEmail, setGoogleEmail] = useState<string | null>(null);
  /** 학원 메뉴 권한을 위임받은 직원 — 학원 관리 화면(5탭)으로 가는 길 */
  const [hasAcademyMenus, setHasAcademyMenus] = useState(false);
  const [myClasses, setMyClasses] = useState<MyClassesData>({ students: [], classes: [] });
  const [listError, setListError] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const { logout: onLogout, logoutBusy, logoutModal } = useRoleLogout({
    redirectTo: "/login/teacher",
    role: "teacher",
  });
  const [listRefreshBusy, setListRefreshBusy] = useState(false);
  const [notifyMessage, setNotifyMessage] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [listInitialLoading, setListInitialLoading] = useState(false);

  const teacherListLoadedUidRef = useRef<string | null>(null);
  const teacherInitGenerationRef = useRef(0);

  // 콜드부팅 스플래시 — 이 페이지가 준비되면(정상 진입 또는 에러 모두 ready=true) 넘겨받는다.
  useEffect(() => {
    if (ready) hideBootOverlay();
  }, [ready, hideBootOverlay]);

  useEffect(() => {
    const auth = getFirebaseAuth();
    let cancelled = false;

    const resetTeacherListSession = () => {
      teacherListLoadedUidRef.current = null;
    };

    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        resetTeacherListSession();
        teacherInitGenerationRef.current += 1;
        setMyClasses({ students: [], classes: [] });
        setListError(null);
        setAcademyId(null);
        setReady(false);
        setListInitialLoading(false);
        router.replace("/login/teacher");
        return;
      }

      const uid = user.uid;

      if (teacherListLoadedUidRef.current === uid) {
        return;
      }

      const gen = ++teacherInitGenerationRef.current;
      resetTeacherListSession();
      setMyClasses({ students: [], classes: [] });
      setListError(null);
      setListInitialLoading(false);

      try {
        await auth.authStateReady();
        if (
          cancelled ||
          gen !== teacherInitGenerationRef.current ||
          auth.currentUser?.uid !== uid
        ) {
          return;
        }

        await user.getIdToken();
        if (
          cancelled ||
          gen !== teacherInitGenerationRef.current ||
          auth.currentUser?.uid !== uid
        ) {
          return;
        }

        // 대시보드 진입 체크는 캐시를 건너뛰고 항상 최신 상태를 본다 — 45초짜리 캐시가
        // 옛 상태를 돌려주는 걸 막는다. "클레임 우선 판별"은 "active"만 즉시 신뢰하고
        // 그 외에는 항상 미러/콜러블로 재확인하므로(Custom Claims 전파 지연 대응),
        // 여기서 별도로 토큰을 강제 갱신할 필요는 없다.
        const data = await resolveTeacherActivationState(user, { bypassCache: true });
        if (
          cancelled ||
          gen !== teacherInitGenerationRef.current ||
          auth.currentUser?.uid !== uid
        ) {
          return;
        }
        if (!data?.anyActive || !data.primaryAcademyId) {
          const q = new URLSearchParams();
          q.set("state", data?.primaryStatus ?? "unknown");
          if (data?.primaryAcademyId) q.set("academyId", data.primaryAcademyId);
          router.replace(`/teacher/session?${q.toString()}`);
          return;
        }

        const aid = data.primaryAcademyId;
        setAcademyId(aid);
        setInitError(null);
        setReady(true);
        setLastDashboardRoleHint("teacher");
        setListInitialLoading(true);

        try {
          const data = await loadMyClasses(aid, uid);
          // 사용자가 바뀐 뒤 늦게 도착한 응답은 버린다
          if (
            cancelled ||
            gen !== teacherInitGenerationRef.current ||
            auth.currentUser?.uid !== uid
          ) {
            return;
          }
          setMyClasses(data);
          setListError(null);
          teacherListLoadedUidRef.current = uid;
        } catch (err) {
          if (
            !cancelled &&
            gen === teacherInitGenerationRef.current &&
            auth.currentUser?.uid === uid
          ) {
            setMyClasses({ students: [], classes: [] });
            setListError(myClassesErrorMessage(err));
          }
        } finally {
          if (!cancelled && gen === teacherInitGenerationRef.current) {
            setListInitialLoading(false);
          }
        }
      } catch {
        if (!cancelled && gen === teacherInitGenerationRef.current) {
          setInitError("선생님 정보를 불러오지 못했습니다.");
          setReady(true);
        }
      }
    });

    return () => {
      cancelled = true;
      resetTeacherListSession();
      unsub();
    };
  }, [router]);

  const refreshAssignedStudents = useCallback(async () => {
    const auth = getFirebaseAuth();
    const user = auth.currentUser;
    const aid = academyId;
    if (!user?.uid || !aid) {
      return;
    }
    const uid = user.uid;
    const gen = teacherInitGenerationRef.current;
    const stale = () => gen !== teacherInitGenerationRef.current || auth.currentUser?.uid !== uid;
    setListRefreshBusy(true);
    setListError(null);
    try {
      const data = await loadMyClasses(aid, uid);
      if (stale()) return;
      setMyClasses(data);
      setListError(null);
    } catch (err) {
      if (!stale()) setListError(myClassesErrorMessage(err));
    } finally {
      setListRefreshBusy(false);
    }
  }, [academyId]);

  const onAttendanceDone = useCallback((message: string) => setNotifyMessage(message), []);
  const attendanceActions = useAttendanceActions(academyId, onAttendanceDone);

  const {
    modalItems: sentLogItems,
    count: sentLogCount,
    error: sentLogError,
    refresh: refreshSentLog,
    dismissOne: dismissSentLogOne,
    dismissAll: dismissSentLogAll,
  } = useAttendanceNotificationLog({
    academyId,
    limit: 60,
    pollMs: 20_000,
    storageScopeKey: `teacher_${academyId ?? "none"}`,
  });

  useEffect(() => {
    if (!academyId) return;
    let cancelled = false;
    void (async () => {
      const db = getFirebaseDb();
      const uid = getFirebaseAuth().currentUser?.uid;

      try {
        const snap = await getDoc(doc(db, "academies", academyId));
        if (cancelled) return;
        const n = snap.data()?.name;
        setAcademyName(typeof n === "string" ? n : null);
      } catch {
        if (!cancelled) setAcademyName(null);
      }

      if (uid) {
        // 본인 문서를 못 읽으면(규칙 거부·네트워크) 프로필·학원 관리 링크 없이 비워 둠
        const d = await getDoc(doc(db, "academies", academyId, "staff", uid))
          .then((snap) => snap.data())
          .catch(() => undefined);
        if (cancelled) return;
        setMemberDisplayName(
          typeof d?.displayName === "string" ? d.displayName : null,
        );
        const rawPhone = typeof d?.phone === "string" ? d.phone.trim() : "";
        setMemberPhone(rawPhone || null);
        setGoogleLinked(d?.googleLinked === true);
        setGoogleEmail(
          typeof d?.googleEmail === "string" ? d.googleEmail.trim() || null : null,
        );
        setHasAcademyMenus(staffDocHasAcademyMenus(d));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyId]);

  // 학생 상세 시트 — 권한 없는 선생님은 정보 탭만(D10), 판단은 studentAccess(teacherUids)
  const permissions = usePermissions(academyId);
  const detail = useStudentDetailParam();
  const { items: rooms } = useAcademyOptionList(academyId, "rooms");
  const roomLabelOf = useCallback(
    (roomId: string) => rooms.find((r) => r.id === roomId)?.label ?? null,
    [rooms],
  );
  const today = useSeoulToday();
  const classGroups = useMemo(
    () => groupMyClasses(myClasses.classes, myClasses.students, today.weekday),
    [myClasses, today.weekday],
  );
  // 등원 기록 읽기는 규칙과 같게 — 출결·청구서 권한 또는 학생 teacherUids에 본인(내 반 학생은 모두 해당)
  const viewerUid = permissions.viewer?.uid ?? null;
  const canReadAllArrivals = permissions.can(["lessons.attendance", "billing.invoices"]);
  const canReadArrival = useCallback(
    (s: StudentVM) => canReadAllArrivals || (viewerUid !== null && s.teacherUids.includes(viewerUid)),
    [canReadAllArrivals, viewerUid],
  );
  const { markArrival, markClass } = attendanceActions;
  const onAttendanceAction = useCallback(
    (student: StudentVM, cls: AcademyClassBrief, action: ClassAttendanceAction) => {
      setNotifyMessage(null);
      if (action.kind === "arrive") {
        void markArrival(student.id, "present", "teacher_my_classes", student.name);
      } else {
        void markClass(cls.id, cls.name, student.id, action.status, "teacher_my_classes", student.name);
      }
    },
    [markArrival, markClass],
  );

  const headerProfile = useMemo(
    () =>
      buildDashboardHeaderProfile(authProfile, {
        displayName: memberDisplayName,
        phone: memberPhone,
        googleLinked,
        googleEmail,
      }),
    [authProfile, googleEmail, googleLinked, memberDisplayName, memberPhone],
  );

  if (!ready) {
    return (
      <RoleDashboardBootShell
        loadingLabel="선생님 대시보드 확인 중"
        footerHint="선생님 계정과 연결 정보를 확인하는 중입니다."
      />
    );
  }

  if (initError) {
    return (
      <div className="min-h-[100dvh] bg-background px-4 py-10 flex flex-col items-center justify-center">
        <div className={`w-full max-w-[520px] p-8 ${glassCard}`}>
          <p className="text-center text-sm text-neutral-700">{initError}</p>
          <button
            type="button"
            onClick={() => void onLogout()}
            disabled={logoutBusy}
            className="mt-6 w-full rounded-2xl bg-[#222] dark:bg-neutral-100 py-3 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-60"
          >
            {logoutBusy ? "처리 중…" : "로그아웃"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background px-4 pb-28">
      <div className="mx-auto max-w-lg">
        <DashboardRoleHeader
          title="선생님 대시보드"
          affiliationLabel={academyLabelForGreeting(academyName, academyId)}
          includeSettingsAction
          onSettingsAction={() => router.push("/teacher/settings")}
          onHomeAction={() => router.push("/")}
          onBellClickAction={() => {
            void refreshSentLog();
            setNotificationsOpen(true);
          }}
          bellBadgeCount={sentLogCount}
          extraMenuActions={
            hasAcademyMenus && academyId
              ? [{ label: "학원 관리 화면", onSelectAction: () => router.push(academyPath(academyId)) }]
              : undefined
          }
          bottomTabs={[
            {
              id: "home",
              label: "홈",
              iconAction: (active: boolean) => <HomeTabIcon active={active} />,
              active: true,
              // "/"는 위임 직원을 학원 5탭으로 보내므로 이 화면에 머문다
              onSelectAction: () => router.push("/teacher"),
            },
          ]}
          onLogoutAction={() => void onLogout()}
          logoutBusy={logoutBusy}
          profile={headerProfile}
        />

        {hasAcademyMenus && academyId ? (
          <button
            type="button"
            onClick={() => router.push(academyPath(academyId))}
            className={`mt-[26px] flex w-full items-center justify-between gap-3 px-4 py-3 text-left ${glassCard}`}
          >
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground">학원 관리 화면</span>
              <span className="mt-0.5 block text-xs text-neutral-500">
                위임받은 메뉴(운영·수납·수업·설정)로 이동합니다.
              </span>
            </span>
            <span aria-hidden className="shrink-0 text-neutral-400">›</span>
          </button>
        ) : null}
        {/* <p className="mb-6 mt-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          전담 학생 정보는 <span className="font-medium text-neutral-700 dark:text-neutral-300">조회만</span> 가능합니다.
          수정·삭제는 학원 대시보드에서 진행됩니다.
        </p> */}

        <div className="mt-[26px] mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">내 반</h2>
          <button
            type="button"
            onClick={() => void refreshAssignedStudents()}
            disabled={listRefreshBusy || !academyId}
            className="rounded-[8px] border border-neutral-300/80 bg-white/70 px-3 py-2 text-[11px] font-medium text-neutral-800 hover:bg-white disabled:opacity-50"
          >
            {listRefreshBusy ? "불러오는 중…" : "목록 새로고침"}
          </button>
        </div>

        {listError ? (
          <p className="rounded-2xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
            {listError}
          </p>
        ) : null}

        {notifyMessage ? (
          <p role="status" className="sticky top-2 z-10 mb-2 break-keep rounded-2xl bg-sky-50 dark:bg-sky-950 px-3 py-2 text-center text-xs text-sky-900 dark:text-sky-100 ring-1 ring-sky-500/20">
            {notifyMessage}
          </p>
        ) : null}

        <div className="space-y-2">
          {listInitialLoading ? (
            <StudentListSectionSkeleton
              rows={3}
              label="내 반 불러오는 중"
            />
          ) : classGroups.length === 0 ? (
            listError ? null : (
              <p
                className={`break-keep px-4 py-12 text-center text-sm text-neutral-500 ${glassCard}`}
              >
                담당 반이 없습니다. 학원에서 반 선생님으로 지정되면 여기에
                표시됩니다.
              </p>
            )
          ) : (
            <TeacherMyClasses
              academyId={academyId ?? ""}
              groups={classGroups}
              today={today}
              roomLabelOf={roomLabelOf}
              canReadArrival={canReadArrival}
              busyKey={attendanceActions.busyKey}
              onAttendanceAction={onAttendanceAction}
              onOpenStudentAction={(id) => detail.open(id)}
            />
          )}
        </div>
      </div>

      {detail.studentId && academyId ? (
        <StudentDetailSheet
          key={detail.studentId}
          academyId={academyId}
          studentId={detail.studentId}
          tabParam={detail.tabParam}
          permissions={permissions}
          onTabChangeAction={detail.setTab}
          onCloseAction={detail.close}
        />
      ) : null}

      <DashboardNotificationsModal
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
        heading="내 알림 전송 기록"
        items={sentLogItems}
        emptyLabel={sentLogError ?? "표시할 기록이 없습니다."}
        onDeleteItem={dismissSentLogOne}
        onDeleteAll={dismissSentLogAll}
      />

      <DashboardBottomScrim />
      {logoutModal}
    </div>
  );
}
