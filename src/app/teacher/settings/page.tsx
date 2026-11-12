"use client";

import { FirebaseError } from "firebase/app";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PhoneChangeSheet } from "@/components/phone-verification/phone-change-sheet";
import { formatKrPhoneDisplay } from "@/lib/phone/kr-phone";
import { octomoPhoneKey } from "@/lib/phone/octomo-phone-key";
import { HomeTabIcon } from "@/components/dashboard/attn-tab-logo";
import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";
import { DashboardRoleHeader } from "@/components/dashboard/dashboard-role-header";
import {
  TeacherLoginIdSettingsCard,
  TeacherPasswordSettingsCard,
} from "@/components/teacher/teacher-account-settings-cards";
import { TeacherGoogleLinkCard } from "@/components/teacher/teacher-google-link-card";
import { SettingsAccordionItem } from "@/components/ui/settings-accordion-item";
import {
  getFirebaseAuth,
  getFirebaseDb,
  getFirebaseFunctions,
} from "@/lib/firebase/client-app";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";
import { useDashboardRefetchOnFocus } from "@/lib/firebase/use-dashboard-refetch-on-focus";
import { resolveTeacherActivationState } from "@/lib/firebase/resolve-session-dashboard";
import { useRoleLogout } from "@/lib/auth/use-role-logout";
import { buildDashboardHeaderProfile } from "@/lib/ui/dashboard-header-profile";
import { academyLabelForGreeting } from "@/lib/ui/dashboard-greetings";
import { doc, getDoc } from "firebase/firestore";import { LegalLinks } from "@/components/legal/legal-links";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

export default function TeacherSettingsPage() {
  const router = useRouter();
  const { profile: authProfile } = useAuthProfile();
  const savingRef = useRef(false);
  const authReadyRef = useRef(false);
  const [academyId, setAcademyId] = useState<string | null>(null);
  const [academyName, setAcademyName] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [phoneSheetOpen, setPhoneSheetOpen] = useState(false);
  const [phoneMessage, setPhoneMessage] = useState<string | null>(null);
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
        if (authReadyRef.current && !savingRef.current) {
          router.replace("/login/teacher");
        }
        return;
      }
      if (savingRef.current) return;
      authReadyRef.current = true;
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

  const loadTeacherMember = useCallback(async () => {
    if (!academyId) return;
    const uid = getFirebaseAuth().currentUser?.uid;
    if (!uid) return;
    const db = getFirebaseDb();
    const snap = await getDoc(doc(db, "academies", academyId, "staff", uid));
    const d = snap.data();
    setDisplayName(typeof d?.displayName === "string" ? d.displayName : "");
    const storedPhone = typeof d?.phone === "string" ? d.phone : "";
    setPhone(formatKrPhoneDisplay(storedPhone));
    setPhoneVerified(octomoPhoneKey(storedPhone) !== "" && d?.phoneVerifiedKey === octomoPhoneKey(storedPhone));
    setAttnId(typeof d?.attnId === "string" ? d.attnId : "");
    setLoginId(typeof d?.loginId === "string" ? d.loginId : "");
    setGoogleLinked(d?.googleLinked === true);
    setGoogleEmail(typeof d?.googleEmail === "string" ? d.googleEmail : "");
  }, [academyId]);

  const { refresh: refreshTeacherMember } = useDashboardRefetchOnFocus(loadTeacherMember, [
    academyId,
  ]);

  useEffect(() => {
    if (!academyId) return;
    let cancelled = false;
    void (async () => {
      try {
        const db = getFirebaseDb();
        const snap = await getDoc(doc(db, "academies", academyId));
        if (cancelled) return;
        const n = snap.data()?.name;
        setAcademyName(typeof n === "string" ? n : null);
      } catch {
        if (!cancelled) setAcademyName(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyId]);

  const onSaveProfile = useCallback(async () => {
    setError(null);
    setSaved(false);
    setBusy(true);
    savingRef.current = true;
    const auth = getFirebaseAuth();
    try {
      const user = auth.currentUser;
      if (!user) {
        setError("로그인이 필요합니다.");
        return;
      }
      const fn = httpsCallable(getFirebaseFunctions(), "updateTeacherProfile");
      // 번호는 [번호 바꾸기](문자 확인 필수)로만 바꾼다 — 여기서는 이름만
      await fn({ displayName: displayName.trim() });
      setSaved(true);
    } catch (e) {
      if (e instanceof FirebaseError) {
        if (e.code === "functions/unauthenticated") {
          setError("로그인이 만료되었습니다. 다시 로그인해 주세요.");
          authReadyRef.current = false;
          await signOut(auth);
          router.replace("/login/teacher");
          return;
        }
        if (e.code === "functions/permission-denied") {
          setError("권한이 없습니다. 다시 로그인한 뒤 시도해 주세요.");
          return;
        }
        setError(e.message || "저장에 실패했습니다.");
      } else {
        setError("저장에 실패했습니다.");
      }
    } finally {
      savingRef.current = false;
      setBusy(false);
      if (!auth.currentUser && authReadyRef.current) {
        router.replace("/login/teacher");
      }
    }
  }, [displayName, router]);

  const headerProfile = useMemo(
    () =>
      buildDashboardHeaderProfile(authProfile, {
        displayName: displayName.trim() || null,
        phone: phone.trim() || null,
        googleLinked,
        googleEmail: googleEmail.trim() || null,
      }),
    [authProfile, displayName, googleEmail, googleLinked, phone],
  );

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
          onBackAction={() => router.back()}
          backAriaLabel="선생님 대시보드로 돌아가기"
          onHomeAction={() => router.push("/")}
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

        <div className="mt-[26px] space-y-4">
          <SettingsAccordionItem title="프로필">
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
              <div className="flex items-center gap-2">
                <p
                  id="t-phone"
                  className="min-w-0 flex-1 truncate rounded-2xl border border-neutral-300/60 bg-white/30 px-4 py-3 font-mono text-sm text-foreground dark:border-white/12"
                >
                  {phone || "없음"}
                </p>
                <button
                  type="button"
                  disabled={formDisabled || !academyId}
                  onClick={() => {
                    setPhoneMessage(null);
                    setPhoneSheetOpen(true);
                  }}
                  className="shrink-0 rounded-2xl border border-neutral-300/70 bg-white/70 px-3 py-3 text-xs font-medium text-foreground disabled:opacity-50"
                  data-phone-change-open
                >
                  번호 바꾸기
                </button>
              </div>
              {phone ? (
                <p className="mt-1 text-[11px] text-neutral-500" data-phone-verified={phoneVerified ? "yes" : "no"}>
                  {phoneVerified ? "문자로 확인된 번호예요." : "아직 문자로 확인하지 않은 번호예요."}
                </p>
              ) : null}
              {phoneMessage ? (
                <p className="mt-1 break-keep text-sm text-emerald-800" role="status">
                  {phoneMessage}
                </p>
              ) : null}
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
          </SettingsAccordionItem>

          {academyId ? (
            <TeacherLoginIdSettingsCard
              attnId={attnId}
              currentLoginId={loginId}
              disabled={formDisabled}
              onSavedAction={setLoginId}
              defaultCollapsed
            />
          ) : null}

          <TeacherPasswordSettingsCard disabled={formDisabled} defaultCollapsed />

          {academyId ? (
            <TeacherGoogleLinkCard
              loginId={loginId || attnId}
              googleLinked={googleLinked}
              googleEmail={googleEmail}
              defaultCollapsed
              onLinkedAction={refreshTeacherMember}
            />
          ) : null}
        </div>
        <LegalLinks className="mt-6" />
      </div>
      {phoneSheetOpen ? (
        <PhoneChangeSheet
          title="번호 바꾸기"
          intro="새 번호로 문자 확인을 마치면 바뀌어요."
          initialPhone=""
          currentPhone={phone}
          currentVerified={phoneVerified}
          submitAction={async (nextPhone, proof) => {
            await httpsCallable(getFirebaseFunctions(), "updateTeacherProfile")({ phone: nextPhone, phoneProof: proof });
            return "번호를 확인해 바꿨어요.";
          }}
          onDoneAction={(message) => {
            setPhoneSheetOpen(false);
            setPhoneMessage(message);
            void refreshTeacherMember();
          }}
          onCloseAction={() => setPhoneSheetOpen(false)}
        />
      ) : null}
      <DashboardBottomScrim />
      {logoutModal}
    </div>
  );
}
