"use client";

import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, onSnapshot, setDoc, Timestamp } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  docToStudentRow,
  type StudentRowVM,
} from "@/components/academy/academy-student-panel";
import { AttnTabLogo } from "@/components/dashboard/attn-tab-logo";
import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";
import { DashboardRoleHeader } from "@/components/dashboard/dashboard-role-header";
import { IosPwaHintModal } from "@/components/parent/ios-pwa-hint-modal";
import { ParentPushNotificationsCard } from "@/components/parent/parent-push-notifications-card";
import {
  getFirebaseAuth,
  getFirebaseDb,
  getFirebaseFunctions,
} from "@/lib/firebase/client-app";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";
import { academyLabelForGreeting } from "@/lib/ui/dashboard-greetings";
import { isLikelyIos, isStandaloneDisplayMode } from "@/lib/platform/ios-pwa";

const glassCard = "glass-card";

function sortByName(a: StudentRowVM, b: StudentRowVM): number {
  return a.name.localeCompare(b.name, "ko");
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

export default function ParentDashboardPage() {
  const router = useRouter();
  const authProfile = useAuthProfile();
  const [ready, setReady] = useState(false);
  const [academyId, setAcademyId] = useState<string | null>(null);
  const [academyName, setAcademyName] = useState<string | null>(null);
  const [students, setStudents] = useState<StudentRowVM[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [listRefreshBusy, setListRefreshBusy] = useState(false);
  const [authUid, setAuthUid] = useState<string | null>(null);
  const [hideIosPwaHint, setHideIosPwaHint] = useState<boolean | null>(null);
  const [iosAutoModalOpen, setIosAutoModalOpen] = useState(false);

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
        router.replace("/login?role=parent");
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

      let revealUi = false;
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

        const fn = httpsCallable(
          getFirebaseFunctions(),
          "getParentActivationState",
        );
        const res = await fn({});
        if (
          cancelled ||
          gen !== parentInitGenerationRef.current ||
          auth.currentUser?.uid !== uid
        ) {
          return;
        }

        const data = res.data as {
          anyActive?: boolean;
          primaryStatus?: string | null;
          primaryAcademyId?: string | null;
        };
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
        revealUi = true;

        await user.getIdToken(true);
        if (
          cancelled ||
          gen !== parentInitGenerationRef.current ||
          auth.currentUser?.uid !== uid
        ) {
          return;
        }

        try {
          const listFn = httpsCallable(
            getFirebaseFunctions(),
            "listParentChildrenStudents",
          );
          const listRes = await listFn({ academyId: aid });
          if (
            cancelled ||
            gen !== parentInitGenerationRef.current ||
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
          parentListLoadedUidRef.current = uid;
        } catch {
          if (!cancelled && gen === parentInitGenerationRef.current) {
            setStudents([]);
            setListError(
              "자녀 학생 목록을 불러오지 못했습니다. 잠시 후 새로고침해 주세요.",
            );
          }
        }
      } catch {
        if (!cancelled && gen === parentInitGenerationRef.current) {
          setInitError("학부모 정보를 불러오지 못했습니다.");
          revealUi = true;
        }
      }
      if (revealUi && !cancelled && gen === parentInitGenerationRef.current) {
        setReady(true);
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
    const db = getFirebaseDb();
    const ref = doc(db, "users", authUid);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        setHideIosPwaHint(snap.data()?.attn_hide_ios_pwa_hint === true);
      },
      () => setHideIosPwaHint(false),
    );
    return () => unsub();
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
      await user.getIdToken(true);
      const listFn = httpsCallable(
        getFirebaseFunctions(),
        "listParentChildrenStudents",
      );
      const listRes = await listFn({ academyId: aid });
      const payload = listRes.data as { students?: CallableStudentPayload[] };
      const rawList = Array.isArray(payload?.students) ? payload.students : [];
      const list = rawList.map((s) => studentRowFromCallablePayload(s));
      list.sort(sortByName);
      setStudents(list);
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
    const db = getFirebaseDb();
    const unsub = onSnapshot(
      doc(db, "academies", academyId),
      (snap) => {
        const n = snap.data()?.name;
        setAcademyName(typeof n === "string" ? n : null);
      },
      () => setAcademyName(null),
    );
    return () => unsub();
  }, [academyId]);

  const onLogout = useCallback(async () => {
    setLogoutBusy(true);
    try {
      parentListLoadedUidRef.current = null;
      await signOut(getFirebaseAuth());
    } finally {
      setLogoutBusy(false);
      router.replace("/login?role=parent");
    }
  }, [router]);

  if (!ready) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
        <p className="text-sm text-neutral-600">불러오는 중…</p>
      </div>
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
          onSettings={() => router.push("/parent/settings")}
          onHome={() => router.push("/")}
          showBellOnTitle
          showBellInBottomBar={false}
          bottomTabs={[
            {
              id: "home",
              label: "홈",
              showLabel: false,
              icon: (active: boolean) => <AttnTabLogo active={active} />,
              active: true,
              onSelect: () => router.push("/"),
            },
          ]}
          onLogout={() => void onLogout()}
          logoutBusy={logoutBusy}
          profile={authProfile}
        />
        {/* <p className="mb-4 mt-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          연결된 자녀 학생 정보를 확인할 수 있습니다.
        </p> */}

        <div className="mt-5 mb-4">
          <ParentPushNotificationsCard />
        </div>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">자녀 학생</h2>
          <button
            type="button"
            onClick={() => void refreshChildrenList()}
            disabled={listRefreshBusy || !academyId}
            className="rounded-xl border border-neutral-300/80 bg-white/70 px-3 py-2 text-[11px] font-medium text-neutral-800 hover:bg-white disabled:opacity-50"
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
          {students.length === 0 ? (
            <p
              className={`py-12 text-center text-sm text-neutral-500 ${glassCard}`}
            >
              등록된 자녀 학생이 없습니다. 학원에서 자녀를 연결하면 여기에
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
                  연락 <span className="text-foreground">{s.phone || "—"}</span>
                </p>
                <p className="mt-0.5 text-[11px] text-neutral-600">
                  비상 연락{" "}
                  <span className="text-foreground">
                    {s.emergencyContact || "—"}
                  </span>
                </p>
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
      </div>

      <DashboardBottomScrim />
    </div>
  );
}
