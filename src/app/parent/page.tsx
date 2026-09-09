"use client";

import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, setDoc, Timestamp } from "firebase/firestore";
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
import { ParentCheckInPinCard } from "@/components/parent/parent-check-in-pin-card";
import { ParentSessionBalanceCard } from "@/components/parent/parent-session-balance-card";
import { ParentTuitionReminderCard } from "@/components/parent/parent-tuition-reminder-card";
import {
  PaymentReminderModal,
  type PaymentReminderPayload,
} from "@/components/parent/payment-reminder-modal";
import { IosPwaHintModal } from "@/components/parent/ios-pwa-hint-modal";
import { academyTuitionSettingsPath } from "@/lib/firebase/attn-schema";
import {
  getFirebaseAuth,
  getFirebaseDb,
  getFirebaseFunctions,
} from "@/lib/firebase/client-app";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";
import { useParentDashboardBell } from "@/lib/firebase/use-parent-dashboard-bell";
import { setLastDashboardRoleHint } from "@/lib/auth/last-dashboard-role";
import { resolveParentActivationState } from "@/lib/firebase/resolve-session-dashboard";
import { useRoleLogout } from "@/lib/auth/use-role-logout";
import { buildDashboardHeaderProfile } from "@/lib/ui/dashboard-header-profile";
import { academyLabelForGreeting } from "@/lib/ui/dashboard-greetings";
import { isLikelyIos, isStandaloneDisplayMode } from "@/lib/platform/ios-pwa";
import { FirebaseError } from "firebase/app";
import { formatKrPhoneDisplay } from "@/lib/phone/kr-phone";

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
  hasCheckInPin?: boolean;
  tuitionDueDayOfMonth?: number | null;
  tuitionAmount?: number | null;
  weeklySessionCount?: number | null;
  pricePerSession?: number | null;
  sessionBalance?: number | null;
  extraSessionDates?: string[];
  hasPendingPaymentReminder?: boolean;
};

type ParentStudentRow = StudentRowVM & {
  hasCheckInPin?: boolean;
  tuitionDueDayOfMonth?: number | null;
  tuitionAmount?: number | null;
  weeklySessionCount?: number | null;
  pricePerSession?: number | null;
  sessionBalance?: number | null;
  extraSessionDates?: string[];
  hasPendingPaymentReminder?: boolean;
};

type TuitionSettingsState = {
  kakaoPayLink?: string;
  bankName?: string;
  accountNumber?: string;
  accountHolder?: string;
} | null;

type ParentListPayload = {
  students?: CallableStudentPayload[];
  kiosk?: { requireStudentCheckInPin?: boolean };
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

export default function ParentDashboardPage() {
  const router = useRouter();
  const { profile: authProfile } = useAuthProfile();
  const [ready, setReady] = useState(false);
  const [academyId, setAcademyId] = useState<string | null>(null);
  const [academyName, setAcademyName] = useState<string | null>(null);
  const [memberDisplayName, setMemberDisplayName] = useState<string | null>(null);
  const [memberPhone, setMemberPhone] = useState<string | null>(null);
  const [googleLinked, setGoogleLinked] = useState(false);
  const [googleEmail, setGoogleEmail] = useState<string | null>(null);
  const [students, setStudents] = useState<StudentRowVM[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const { logout: onLogout, logoutBusy, logoutModal } = useRoleLogout({
    redirectTo: "/login/parent",
    role: "parent",
  });
  const [listRefreshBusy, setListRefreshBusy] = useState(false);
  const [authUid, setAuthUid] = useState<string | null>(null);
  const [hideIosPwaHint, setHideIosPwaHint] = useState<boolean | null>(null);
  const [iosAutoModalOpen, setIosAutoModalOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [listInitialLoading, setListInitialLoading] = useState(false);
  const [kioskRequirePin, setKioskRequirePin] = useState(false);
  const [studentsWithPinMeta, setStudentsWithPinMeta] = useState<
    ParentStudentRow[]
  >([]);
  const [tuitionSettings, setTuitionSettings] =
    useState<TuitionSettingsState>(null);
  const [reminderPayload, setReminderPayload] = useState<PaymentReminderPayload | null>(null);
  const shownReminderForRef = useRef<Set<string>>(new Set());

  const {
    items: parentBellItems,
    count: parentBellCount,
    error: parentBellError,
    deleteItem: deleteParentBellItem,
    deleteAllItems: deleteAllParentBellItems,
  } = useParentDashboardBell(authUid);

  const parentListLoadedUidRef = useRef<string | null>(null);
  const parentInitGenerationRef = useRef(0);

  useEffect(() => {
    const auth = getFirebaseAuth();
    let cancelled = false;

    const resetParentListSession = () => {
      parentListLoadedUidRef.current = null;
    };

    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        resetParentListSession();
        parentInitGenerationRef.current += 1;
        setStudents([]);
        setListError(null);
        setAcademyId(null);
        setReady(false);
        setAuthUid(null);
        setHideIosPwaHint(null);
        setListInitialLoading(false);
        router.replace("/login/parent");
        return;
      }

      const uid = user.uid;
      setAuthUid(uid);

      if (parentListLoadedUidRef.current === uid) {
        return;
      }

      const gen = ++parentInitGenerationRef.current;
      resetParentListSession();
      setStudents([]);
      setListError(null);
      setListInitialLoading(false);

      try {
        await auth.authStateReady();
        if (
          cancelled ||
          gen !== parentInitGenerationRef.current ||
          auth.currentUser?.uid !== uid
        ) {
          return;
        }

        await user.getIdToken();
        if (
          cancelled ||
          gen !== parentInitGenerationRef.current ||
          auth.currentUser?.uid !== uid
        ) {
          return;
        }

        const data = await resolveParentActivationState(user);
        if (
          cancelled ||
          gen !== parentInitGenerationRef.current ||
          auth.currentUser?.uid !== uid
        ) {
          return;
        }
        if (!data?.anyActive || !data.primaryAcademyId) {
          const q = new URLSearchParams();
          q.set("state", data?.primaryStatus ?? "unknown");
          if (data?.primaryAcademyId) q.set("academyId", data.primaryAcademyId);
          router.replace(`/parent/session?${q.toString()}`);
          return;
        }

        const aid = data.primaryAcademyId;
        setAcademyId(aid);
        setInitError(null);
        setReady(true);
        setLastDashboardRoleHint("parent");
        setListInitialLoading(true);

        try {
          const listFn = httpsCallable(
            getFirebaseFunctions(),
            "listParentChildrenStudents",
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
            gen !== parentInitGenerationRef.current ||
            auth.currentUser?.uid !== uid
          ) {
            return;
          }

          const payload = listRes.data as ParentListPayload;
          const rawList = Array.isArray(payload?.students)
            ? payload.students
            : [];
          const list = rawList.map((s) => ({
            ...studentRowFromCallablePayload(s),
            hasCheckInPin: s.hasCheckInPin === true,
            tuitionDueDayOfMonth: s.tuitionDueDayOfMonth ?? null,
            tuitionAmount: typeof s.tuitionAmount === "number" ? s.tuitionAmount : null,
            weeklySessionCount: typeof s.weeklySessionCount === "number" ? s.weeklySessionCount : null,
            pricePerSession: typeof s.pricePerSession === "number" ? s.pricePerSession : null,
            sessionBalance: typeof s.sessionBalance === "number" ? s.sessionBalance : null,
            extraSessionDates: Array.isArray(s.extraSessionDates) ? s.extraSessionDates : [],
            hasPendingPaymentReminder: s.hasPendingPaymentReminder === true,
          }));
          list.sort(sortByName);
          setStudents(list);
          setStudentsWithPinMeta(list);
          setKioskRequirePin(payload?.kiosk?.requireStudentCheckInPin === true);
          setListError(null);
          parentListLoadedUidRef.current = uid;
        } catch {
          if (!cancelled && gen === parentInitGenerationRef.current) {
            setStudents([]);
            setListError(
              "자녀 학생 목록을 불러오지 못했습니다. 잠시 후 새로고침해 주세요.",
            );
          }
        } finally {
          if (!cancelled && gen === parentInitGenerationRef.current) {
            setListInitialLoading(false);
          }
        }
      } catch {
        if (!cancelled && gen === parentInitGenerationRef.current) {
          setInitError("학부모 정보를 불러오지 못했습니다.");
          setReady(true);
        }
      }
    });

    return () => {
      cancelled = true;
      resetParentListSession();
      unsub();
    };
  }, [router]);

  useEffect(() => {
    if (!authUid || !ready) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const db = getFirebaseDb();
        const snap = await getDoc(doc(db, "users", authUid));
        if (cancelled) return;
        setHideIosPwaHint(snap.data()?.attn_hide_ios_pwa_hint === true);
      } catch {
        if (!cancelled) setHideIosPwaHint(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authUid, ready]);

  useEffect(() => {
    if (!ready || !academyId || hideIosPwaHint === null) {
      return;
    }
    if (hideIosPwaHint) {
      return;
    }
    if (!isLikelyIos() || isStandaloneDisplayMode()) {
      return;
    }
    try {
      if (sessionStorage.getItem("attn_ios_auto_hint_dismissed")) {
        return;
      }
    } catch {
      /* ignore */
    }
    setIosAutoModalOpen(true);
  }, [ready, academyId, hideIosPwaHint]);

  const dismissIosAutoModal = useCallback(() => {
    try {
      sessionStorage.setItem("attn_ios_auto_hint_dismissed", "1");
    } catch {
      /* ignore */
    }
    setIosAutoModalOpen(false);
  }, []);

  // 페이지 진입 시 미확인 납부 안내가 있는 학생을 찾아 모달 자동 오픈
  useEffect(() => {
    if (listInitialLoading || !academyId) return;
    const candidate = studentsWithPinMeta.find(
      (s) => s.hasPendingPaymentReminder && !shownReminderForRef.current.has(s.id),
    );
    if (!candidate || candidate.weeklySessionCount == null) return;

    shownReminderForRef.current.add(candidate.id);

    const wc = candidate.weeklySessionCount;
    const balance = candidate.sessionBalance ?? 0;
    const extraCount = candidate.extraSessionDates?.length ?? 0;
    const monthlySessionCount = wc * 4;
    let body: string;
    if (balance <= 0) {
      body = `${candidate.name} 학생의 수업 잔여 횟수가 없습니다`;
      if (extraCount > 0) body += ` (초과 ${extraCount}회 발생)`;
      body += `. 다음 4주 수업(${monthlySessionCount}회)을 위해 납부를 부탁드립니다.`;
    } else {
      body = `${candidate.name} 학생의 잔여 수업이 ${balance}회 남았습니다`;
      body += `. 다음 4주 수업(${monthlySessionCount}회)을 위해 납부를 부탁드립니다.`;
    }
    const debtSessions = Math.max(0, -balance);
    const totalSessions = monthlySessionCount + debtSessions;
    const suggestedAmount =
      candidate.pricePerSession != null
        ? String(totalSessions * candidate.pricePerSession)
        : undefined;

    setReminderPayload({
      body,
      studentName: candidate.name,
      studentId: candidate.id,
      academyId,
      suggestedAmount,
      kakaoPayLink: tuitionSettings?.kakaoPayLink,
      bankName: tuitionSettings?.bankName,
      accountNumber: tuitionSettings?.accountNumber,
      accountHolder: tuitionSettings?.accountHolder,
    });
  }, [studentsWithPinMeta, listInitialLoading, academyId, tuitionSettings]);

  const refreshChildrenList = useCallback(async () => {
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
        "listParentChildrenStudents",
      );
      let listRes;
      try {
        listRes = await listFn({ academyId: aid });
      } catch (err) {
        if (!isRetryableCallableAuthError(err)) throw err;
        await user.getIdToken(true);
        listRes = await listFn({ academyId: aid });
      }
      const payload = listRes.data as ParentListPayload;
      const rawList = Array.isArray(payload?.students) ? payload.students : [];
      const list = rawList.map((s) => ({
        ...studentRowFromCallablePayload(s),
        hasCheckInPin: s.hasCheckInPin === true,
        tuitionDueDayOfMonth: s.tuitionDueDayOfMonth ?? null,
        tuitionAmount: typeof s.tuitionAmount === "number" ? s.tuitionAmount : null,
        weeklySessionCount: typeof s.weeklySessionCount === "number" ? s.weeklySessionCount : null,
        pricePerSession: typeof s.pricePerSession === "number" ? s.pricePerSession : null,
        sessionBalance: typeof s.sessionBalance === "number" ? s.sessionBalance : null,
        extraSessionDates: Array.isArray(s.extraSessionDates) ? s.extraSessionDates : [],
      }));
      list.sort(sortByName);
      setStudents(list);
      setStudentsWithPinMeta(list);
      setKioskRequirePin(payload?.kiosk?.requireStudentCheckInPin === true);
      setListError(null);
    } catch {
      setListError(
        "자녀 학생 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
      );
    } finally {
      setListRefreshBusy(false);
    }
  }, [academyId]);

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
        const snap = await getDoc(doc(db, "academies", academyId, "parents", uid));
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

      try {
        const snap = await getDoc(doc(db, academyTuitionSettingsPath(academyId)));
        if (cancelled) return;
        if (snap.exists()) {
          const d = snap.data();
          setTuitionSettings({
            kakaoPayLink: typeof d?.kakaoPayLink === "string" && d.kakaoPayLink ? d.kakaoPayLink : undefined,
            bankName: typeof d?.bankName === "string" && d.bankName ? d.bankName : undefined,
            accountNumber: typeof d?.accountNumber === "string" && d.accountNumber ? d.accountNumber : undefined,
            accountHolder: typeof d?.accountHolder === "string" && d.accountHolder ? d.accountHolder : undefined,
          });
        } else {
          setTuitionSettings(null);
        }
      } catch {
        if (!cancelled) setTuitionSettings(null);
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
        loadingLabel="학부모 대시보드 확인 중"
        footerHint="학부모 계정과 연결 정보를 확인하는 중입니다."
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
          title="학부모 대시보드"
          affiliationLabel={academyLabelForGreeting(academyName, academyId)}
          includeSettingsAction
          onSettingsAction={() => router.push("/parent/settings")}
          onHomeAction={() => router.push("/")}
          onBellClickAction={() => setNotificationsOpen(true)}
          bellBadgeCount={parentBellCount}
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
        {/* <p className="mb-4 mt-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          연결된 자녀 학생 정보를 확인할 수 있습니다.
        </p> */}

        <div className="mt-[26px] mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">자녀 학생</h2>
          <button
            type="button"
            onClick={() => void refreshChildrenList()}
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

        <div className="space-y-2">
          {listInitialLoading ? (
            <StudentListSectionSkeleton
              rows={3}
              label="자녀 학생 목록 불러오는 중"
            />
          ) : students.length === 0 ? (
            <p
              className={`py-12 text-center text-sm text-neutral-500 ${glassCard}`}
            >
              등록된 자녀 학생이 없습니다. 학원에서 자녀를 연결하면 여기에
              표시됩니다.
            </p>
          ) : (
            studentsWithPinMeta.map((s) => (
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
                {kioskRequirePin ? (
                  <ParentCheckInPinCard
                    academyId={academyId!}
                    student={s}
                    onUpdatedAction={() => void refreshChildrenList()}
                  />
                ) : null}
                {s.tuitionDueDayOfMonth ? (
                  <ParentTuitionReminderCard
                    tuitionDueDayOfMonth={s.tuitionDueDayOfMonth}
                    tuitionAmount={s.tuitionAmount}
                    settings={tuitionSettings}
                  />
                ) : s.weeklySessionCount != null ? (
                  <ParentSessionBalanceCard
                    weeklySessionCount={s.weeklySessionCount}
                    pricePerSession={s.pricePerSession ?? null}
                    sessionBalance={s.sessionBalance ?? null}
                    extraSessionDates={s.extraSessionDates ?? []}
                    settings={tuitionSettings}
                  />
                ) : null}
              </div>
            ))
          )}
        </div>

        <IosPwaHintModal
          open={iosAutoModalOpen}
          onCloseAction={dismissIosAutoModal}
          onConfirmAction={async (dontShowAgain) => {
            try {
              sessionStorage.setItem("attn_ios_auto_hint_dismissed", "1");
            } catch {
              /* ignore */
            }
            if (!dontShowAgain || !authUid) {
              return;
            }
            await setDoc(
              doc(getFirebaseDb(), "users", authUid),
              { attn_hide_ios_pwa_hint: true },
              { merge: true },
            );
          }}
        />

        <DashboardNotificationsModal
          open={notificationsOpen}
          onClose={() => setNotificationsOpen(false)}
          heading="알림"
          items={parentBellItems}
          emptyLabel={parentBellError ?? "표시할 알림이 없습니다."}
          onDeleteItem={(id) => void deleteParentBellItem(id)}
          onDeleteAll={() => void deleteAllParentBellItems()}
        />
      </div>

      <DashboardBottomScrim />
      {logoutModal}
      {reminderPayload ? (
        <PaymentReminderModal
          payload={reminderPayload}
          onConfirmAction={() => setReminderPayload(null)}
        />
      ) : null}
    </div>
  );
}
