"use client";

import { FirebaseError } from "firebase/app";
import { formatKrPhoneDisplay } from "@/lib/phone/kr-phone";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, Timestamp } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  docToStudentRow,
  type StudentRowVM,
} from "@/components/academy/academy-student-panel";
import { HomeTabIcon } from "@/components/dashboard/attn-tab-logo";
import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";
import { DashboardNotificationsModal } from "@/components/dashboard/dashboard-notifications-modal";
import { DashboardRoleHeader } from "@/components/dashboard/dashboard-role-header";
import { RoleDashboardBootShell } from "@/components/dashboard/role-dashboard-boot-shell";
import { StudentListSectionSkeleton } from "@/components/dashboard/student-list-section-skeleton";
import {
  getFirebaseAuth,
  getFirebaseDb,
  getFirebaseFunctions,
} from "@/lib/firebase/client-app";
import { useAttendanceNotificationLog } from "@/lib/firebase/use-attendance-notification-log";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";
import { resolveTeacherActivationState } from "@/lib/firebase/resolve-session-dashboard";
import { useRoleLogout } from "@/lib/auth/use-role-logout";
import { buildDashboardHeaderProfile } from "@/lib/ui/dashboard-header-profile";
import { academyLabelForGreeting } from "@/lib/ui/dashboard-greetings";

const glassCard = "glass-card";

function sortByName(a: StudentRowVM, b: StudentRowVM): number {
  return a.name.localeCompare(b.name, "ko");
}

function isRetryableCallableAuthError(err: unknown): boolean {
  if (!(err instanceof FirebaseError)) return false;
  return (
    err.code === "functions/unauthenticated" ||
    err.code === "functions/permission-denied"
  );
}

type CallableStudentPayload = {
  id: string;
  parentUserId?: string;
  name?: string;
  age?: number;
  phone?: string;
  emergencyContact?: string;
  assignedTeacherUids?: string[];
  assignedTeacherUid?: string | null;
  createdAtMillis?: number | null;
};

function studentRowFromCallablePayload(
  s: CallableStudentPayload,
): StudentRowVM {
  const createdAt =
    typeof s.createdAtMillis === "number"
      ? Timestamp.fromMillis(s.createdAtMillis)
      : undefined;
  return docToStudentRow(s.id, {
    parentUserId: s.parentUserId ?? "",
    name: s.name ?? "",
    age: s.age ?? 0,
    phone: s.phone ?? "",
    emergencyContact: s.emergencyContact ?? "",
    assignedTeacherUids: s.assignedTeacherUids ?? [],
    ...(s.assignedTeacherUid
      ? { assignedTeacherUid: s.assignedTeacherUid }
      : {}),
    ...(createdAt ? { createdAt } : {}),
  });
}

export default function TeacherDashboardPage() {
  const router = useRouter();
  const { profile: authProfile } = useAuthProfile();
  const [ready, setReady] = useState(false);
  const [academyId, setAcademyId] = useState<string | null>(null);
  const [academyName, setAcademyName] = useState<string | null>(null);
  const [memberPhone, setMemberPhone] = useState<string | null>(null);
  const [memberDisplayName, setMemberDisplayName] = useState<string | null>(null);
  const [googleLinked, setGoogleLinked] = useState(false);
  const [googleEmail, setGoogleEmail] = useState<string | null>(null);
  const [students, setStudents] = useState<StudentRowVM[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const { logout: onLogout, logoutBusy, logoutModal } = useRoleLogout({
    redirectTo: "/login/teacher",
    role: "teacher",
  });
  const [listRefreshBusy, setListRefreshBusy] = useState(false);
  const [notifyMessage, setNotifyMessage] = useState<string | null>(null);
  const [notifyBusyKey, setNotifyBusyKey] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [listInitialLoading, setListInitialLoading] = useState(false);

  const teacherListLoadedUidRef = useRef<string | null>(null);
  const teacherInitGenerationRef = useRef(0);

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
        setStudents([]);
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
      setStudents([]);
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

        const data = await resolveTeacherActivationState(user);
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
        setListInitialLoading(true);

        try {
          const listFn = httpsCallable(
            getFirebaseFunctions(),
            "listTeacherAssignedStudents",
          );
          let listRes;
          try {
            listRes = await listFn({ academyId: aid });
          } catch (err) {
            if (!isRetryableCallableAuthError(err)) throw err;
            await user.getIdToken(true);
            listRes = await listFn({ academyId: aid });
          }
          if (
            cancelled ||
            gen !== teacherInitGenerationRef.current ||
            auth.currentUser?.uid !== uid
          ) {
            return;
          }

          const payload = listRes.data as {
            students?: CallableStudentPayload[];
          };
          const rawList = Array.isArray(payload?.students)
            ? payload.students
            : [];
          const list = rawList.map((s) => studentRowFromCallablePayload(s));
          list.sort(sortByName);
          setStudents(list);
          setListError(null);
          teacherListLoadedUidRef.current = uid;
        } catch {
          if (!cancelled && gen === teacherInitGenerationRef.current) {
            setStudents([]);
            setListError(
              "전담 학생 목록을 불러오지 못했습니다. 잠시 후 새로고침해 주세요.",
            );
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
    setListRefreshBusy(true);
    setListError(null);
    try {
      const listFn = httpsCallable(
        getFirebaseFunctions(),
        "listTeacherAssignedStudents",
      );
      let listRes;
      try {
        listRes = await listFn({ academyId: aid });
      } catch (err) {
        if (!isRetryableCallableAuthError(err)) throw err;
        await user.getIdToken(true);
        listRes = await listFn({ academyId: aid });
      }
      const payload = listRes.data as { students?: CallableStudentPayload[] };
      const rawList = Array.isArray(payload?.students) ? payload.students : [];
      const list = rawList.map((s) => studentRowFromCallablePayload(s));
      list.sort(sortByName);
      setStudents(list);
      setListError(null);
    } catch {
      setListError(
        "전담 학생 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
      );
    } finally {
      setListRefreshBusy(false);
    }
  }, [academyId]);

  const sendAttendanceNotify = useCallback(
    async (studentId: string, kind: "present" | "absent") => {
      const aid = academyId;
      if (!aid) return;
      const key = `${studentId}-${kind}`;
      setNotifyBusyKey(key);
      setNotifyMessage(null);
      try {
        const fn = httpsCallable(
          getFirebaseFunctions(),
          "sendStudentAttendanceNotification",
        );
        await fn({ academyId: aid, studentId, kind });
        setNotifyMessage(
          kind === "present"
            ? "출석 알림을 보냈습니다."
            : "결석 알림을 보냈습니다.",
        );
      } catch (e) {
        if (e instanceof FirebaseError) {
          if (e.code === "functions/resource-exhausted") {
            setNotifyMessage(
              "같은 학생에게 너무 자주 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.",
            );
            return;
          }
        }
        setNotifyMessage(
          "알림을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.",
        );
      } finally {
        setNotifyBusyKey(null);
      }
    },
    [academyId],
  );

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
        const snap = await getDoc(doc(db, "academies", academyId, "teachers", uid));
        if (cancelled) return;
        const d = snap.data();
        setMemberDisplayName(
          typeof d?.displayName === "string" ? d.displayName : null,
        );
        const rawPhone = typeof d?.phone === "string" ? d.phone.trim() : "";
        setMemberPhone(rawPhone || null);
        setGoogleLinked(d?.googleLinked === true);
        setGoogleEmail(
          typeof d?.googleEmail === "string" ? d.googleEmail.trim() || null : null,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyId]);

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
          bottomTabs={[
            {
              id: "home",
              label: "홈",
              iconAction: (active: boolean) => <HomeTabIcon active={active} />,
              active: true,
              onSelectAction: () => router.push("/"),
            },
          ]}
          onLogoutAction={() => void onLogout()}
          logoutBusy={logoutBusy}
          profile={headerProfile}
        />
        {/* <p className="mb-6 mt-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          전담 학생 정보는 <span className="font-medium text-neutral-700 dark:text-neutral-300">조회만</span> 가능합니다.
          수정·삭제는 학원 대시보드에서 진행됩니다.
        </p> */}

        <div className="mt-[26px] mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">전담 학생</h2>
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
          <p className="mb-2 rounded-2xl bg-sky-500/10 px-3 py-2 text-center text-xs text-sky-900 ring-1 ring-sky-500/20">
            {notifyMessage}
          </p>
        ) : null}

        <div className="space-y-2">
          {listInitialLoading ? (
            <StudentListSectionSkeleton
              rows={3}
              label="전담 학생 목록 불러오는 중"
            />
          ) : students.length === 0 ? (
            <p
              className={`py-12 text-center text-sm text-neutral-500 ${glassCard}`}
            >
              전담으로 연결된 학생이 없습니다. 학원에서 배정이 되면 여기에
              표시됩니다.
            </p>
          ) : (
            students.map((s) => (
              <div key={s.id} className={`p-4 ${glassCard}`}>
                <p className="font-medium text-foreground">
                  {s.name}
                  <span className="font-normal text-neutral-500">
                    {" "}
                    · 만 {s.age}세
                  </span>
                </p>
                <p className="mt-2 text-[11px] text-neutral-600">
                  연락{" "}
                  <span className="text-foreground">
                    {formatKrPhoneDisplay(s.phone) || "—"}
                  </span>
                </p>
                <p className="mt-0.5 text-[11px] text-neutral-600">
                  비상 연락{" "}
                  <span className="text-foreground">
                    {formatKrPhoneDisplay(s.emergencyContact) || "—"}
                  </span>
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={notifyBusyKey !== null}
                    onClick={() => void sendAttendanceNotify(s.id, "present")}
                    className="rounded-[8px] border border-emerald-400/60 bg-emerald-500/15 px-3 py-2 text-[11px] font-medium text-emerald-950 hover:bg-emerald-500/25 disabled:opacity-50"
                  >
                    {notifyBusyKey === `${s.id}-present`
                      ? "전송 중…"
                      : "출석 알림"}
                  </button>
                  <button
                    type="button"
                    disabled={notifyBusyKey !== null}
                    onClick={() => void sendAttendanceNotify(s.id, "absent")}
                    className="rounded-[8px] border border-amber-400/60 bg-amber-500/12 px-3 py-2 text-[11px] font-medium text-amber-950 hover:bg-amber-500/22 disabled:opacity-50"
                  >
                    {notifyBusyKey === `${s.id}-absent`
                      ? "전송 중…"
                      : "결석 알림"}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

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
