"use client";

import { FirebaseError } from "firebase/app";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AttnTabLogo } from "@/components/dashboard/attn-tab-logo";
import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";
import { DashboardRoleHeader } from "@/components/dashboard/dashboard-role-header";
import {
  getFirebaseAuth,
  getFirebaseDb,
  getFirebaseFunctions,
} from "@/lib/firebase/client-app";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";
import { resolveTeacherActivationState } from "@/lib/firebase/resolve-session-dashboard";
import { academyLabelForGreeting } from "@/lib/ui/dashboard-greetings";
import { doc, onSnapshot } from "firebase/firestore";

const glassCard = "glass-card";
const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

export default function TeacherSettingsPage() {
  const router = useRouter();
  const authProfile = useAuthProfile();
  const [academyId, setAcademyId] = useState<string | null>(null);
  const [academyName, setAcademyName] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [attnId, setAttnId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);

  useEffect(() => {
    const auth = getFirebaseAuth();
    return onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login/teacher");
        return;
      }
      const state = await resolveTeacherActivationState(user, { bypassCache: true });
      if (!state.anyActive && state.primaryStatus === "pending_setup") {
        router.replace("/teacher/setup");
        return;
      }
      if (!state.primaryAcademyId) {
        router.replace("/teacher/session?state=unknown");
        return;
      }
      setAcademyId(state.primaryAcademyId);
    });
  }, [router]);

  useEffect(() => {
    if (!academyId) return;
    const uid = getFirebaseAuth().currentUser?.uid;
    if (!uid) return;
    const db = getFirebaseDb();
    const unsubMember = onSnapshot(
      doc(db, "academies", academyId, "teachers", uid),
      (snap) => {
        const d = snap.data();
        setDisplayName(typeof d?.displayName === "string" ? d.displayName : "");
        setAttnId(typeof d?.attnId === "string" ? d.attnId : "");
      },
    );
    const unsubAcademy = onSnapshot(doc(db, "academies", academyId), (snap) => {
      const n = snap.data()?.name;
      setAcademyName(typeof n === "string" ? n : null);
    });
    return () => {
      unsubMember();
      unsubAcademy();
    };
  }, [academyId]);

  const onSave = useCallback(async () => {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "updateTeacherProfile");
      await fn({ displayName: displayName.trim() });
      setSaved(true);
    } catch (e) {
      setError(e instanceof FirebaseError ? e.message : "저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }, [displayName]);

  const onLogout = useCallback(async () => {
    setLogoutBusy(true);
    try {
      await signOut(getFirebaseAuth());
      router.replace("/login/teacher");
    } finally {
      setLogoutBusy(false);
    }
  }, [router]);

  return (
    <div className="min-h-[100dvh] bg-background px-4 pb-28">
      <div className="mx-auto max-w-lg">
        <DashboardRoleHeader
          title="사용자 설정"
          affiliationLabel={academyLabelForGreeting(academyName, academyId ?? "")}
          showBack
          onBackAction={() => router.push("/teacher")}
          backAriaLabel="선생님 대시보드로 돌아가기"
          onHomeAction={() => router.push("/")}
          showBellOnTitle={false}
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
          onLogoutAction={() => void onLogout()}
          logoutBusy={logoutBusy}
          profile={authProfile}
        />

        <section className={`mt-5 space-y-4 p-4 ${glassCard}`}>
          <h2 className="text-sm font-semibold text-foreground">프로필</h2>
          <p className="text-[11px] text-neutral-600">
            로그인 번호는 변경할 수 없습니다. 대시보드에 표시되는 이름만 수정합니다.
          </p>
          <div>
            <p className="text-xs font-medium text-neutral-500">로그인 번호</p>
            <p className="mt-1 font-mono text-sm text-foreground">{attnId || "—"}</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="t-dn">
              표시 이름
            </label>
            <input
              id="t-dn"
              className={inputClass}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={60}
            />
          </div>
          {error ? <p className="text-sm text-red-700">{error}</p> : null}
          {saved ? (
            <p className="text-sm text-emerald-800">저장되었습니다.</p>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void onSave()}
            className="w-full rounded-2xl bg-[#222] py-2.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950 disabled:opacity-60"
          >
            {busy ? "저장 중…" : "이름 저장"}
          </button>
        </section>
      </div>
      <DashboardBottomScrim />
    </div>
  );
}
