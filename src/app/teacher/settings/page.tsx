"use client";

import { FirebaseError } from "firebase/app";
import { onAuthStateChanged } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { KrPhoneInput } from "@/components/ui/kr-phone-input";
import { formatKrPhoneDisplay } from "@/lib/phone/kr-phone";
import { AttnTabLogo } from "@/components/dashboard/attn-tab-logo";
import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";
import { DashboardRoleHeader } from "@/components/dashboard/dashboard-role-header";
import {
  TeacherLoginIdSettingsCard,
  TeacherPasswordSettingsCard,
} from "@/components/teacher/teacher-account-settings-cards";
import { TeacherGoogleLinkCard } from "@/components/teacher/teacher-google-link-card";
import {
  getFirebaseAuth,
  getFirebaseDb,
  getFirebaseFunctions,
} from "@/lib/firebase/client-app";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";
import { resolveTeacherActivationState } from "@/lib/firebase/resolve-session-dashboard";
import { useRoleLogout } from "@/lib/auth/use-role-logout";
import { academyLabelForGreeting } from "@/lib/ui/dashboard-greetings";
import { doc, onSnapshot } from "firebase/firestore";

const glassCard = "glass-card";
const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

export default function TeacherSettingsPage() {
  const router = useRouter();
  const { profile: authProfile, refreshProfile } = useAuthProfile();
  const [academyId, setAcademyId] = useState<string | null>(null);
  const [academyName, setAcademyName] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [attnId, setAttnId] = useState("");
  const [loginId, setLoginId] = useState("");
  const [googleLinked, setGoogleLinked] = useState(false);
  const [googleEmail, setGoogleEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { logout: onLogout, logoutBusy, logoutModal } = useRoleLogout({
    redirectTo: "/login/teacher",
    role: "teacher",
  });

  useEffect(() => {
    const auth = getFirebaseAuth();
    return onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login/teacher");
        return;
      }
      const state = await resolveTeacherActivationState(user, {
        bypassCache: true,
      });
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
        setPhone(formatKrPhoneDisplay(typeof d?.phone === "string" ? d.phone : ""));
        setAttnId(typeof d?.attnId === "string" ? d.attnId : "");
        setLoginId(typeof d?.loginId === "string" ? d.loginId : "");
        setGoogleLinked(d?.googleLinked === true);
        setGoogleEmail(typeof d?.googleEmail === "string" ? d.googleEmail : "");
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

  const onSaveProfile = useCallback(async () => {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "updateTeacherProfile");
      await fn({
        displayName: displayName.trim(),
        phone: phone.trim(),
      });
      await refreshProfile();
      setSaved(true);
    } catch (e) {
      setError(e instanceof FirebaseError ? e.message : "저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }, [displayName, phone, refreshProfile]);

  const headerProfile = useMemo(() => {
    if (!authProfile) return null;
    const name = displayName.trim();
    const formattedPhone = phone.trim() || null;
    return {
      ...authProfile,
      ...(name ? { displayName: name } : {}),
      phone: formattedPhone,
    };
  }, [authProfile, displayName, phone]);

  const formDisabled = busy || logoutBusy;

  return (
    <div className="min-h-[100dvh] bg-background px-4 pb-28">
      <div className="mx-auto max-w-lg">
        <DashboardRoleHeader
          title="사용자 설정"
          affiliationLabel={academyLabelForGreeting(
            academyName,
            academyId ?? "",
          )}
          menuIntro={
            <span className="text-neutral-600 dark:text-neutral-400">
              프로필, Google 연동, 로그인 ID·비밀번호를 관리합니다.
            </span>
          }
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
              iconAction: (active: boolean) => <AttnTabLogo active={active} />,
              active: true,
              onSelectAction: () => router.push("/"),
            },
          ]}
          onLogoutAction={() => void onLogout()}
          logoutBusy={logoutBusy}
          profile={headerProfile}
        />

        <div className="mt-5 space-y-4">
          <section className={`space-y-4 p-4 ${glassCard}`}>
            <h2 className="text-sm font-semibold text-foreground">프로필</h2>
            <div>
              <label
                className="mb-1 block text-xs font-medium text-neutral-600"
                htmlFor="t-dn"
              >
                이름
              </label>
              <input
                id="t-dn"
                className={inputClass}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={60}
                disabled={formDisabled}
                autoComplete="name"
              />
            </div>
            <div>
              <label
                className="mb-1 block text-xs font-medium text-neutral-600"
                htmlFor="t-phone"
              >
                전화번호
              </label>
              <KrPhoneInput
                id="t-phone"
                className={inputClass}
                value={phone}
                onChange={setPhone}
                disabled={formDisabled}
              />
            </div>
            {error ? <p className="text-sm text-red-700">{error}</p> : null}
            {saved ? (
              <p className="text-sm text-emerald-800">저장되었습니다.</p>
            ) : null}
            <button
              type="button"
              disabled={formDisabled}
              onClick={() => void onSaveProfile()}
              className="w-full rounded-2xl bg-[#222] py-2.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950 disabled:opacity-60"
            >
              {busy ? "저장 중…" : "프로필 저장"}
            </button>
          </section>

          {academyId ? (
            <TeacherLoginIdSettingsCard
              attnId={attnId}
              currentLoginId={loginId}
              disabled={formDisabled}
              onSavedAction={setLoginId}
            />
          ) : null}

          <TeacherPasswordSettingsCard disabled={formDisabled} />

          {academyId ? (
            <TeacherGoogleLinkCard
              loginId={loginId || attnId}
              googleLinked={googleLinked}
              googleEmail={googleEmail}
            />
          ) : null}
        </div>
      </div>
      <DashboardBottomScrim />
      {logoutModal}
    </div>
  );
}
