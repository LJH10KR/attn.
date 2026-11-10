"use client";

import { FirebaseError } from "firebase/app";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PhoneChangeSheet } from "@/components/phone-verification/phone-change-sheet";
import { HomeTabIcon } from "@/components/dashboard/attn-tab-logo";
import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";
import { DashboardRoleHeader } from "@/components/dashboard/dashboard-role-header";
import { IosPwaHintModal } from "@/components/parent/ios-pwa-hint-modal";
import {
  ParentLoginIdSettingsCard,
  ParentPasswordSettingsCard,
} from "@/components/parent/parent-account-settings-cards";
import { ParentGoogleLinkCard } from "@/components/parent/parent-google-link-card";
import { ParentPushNotificationsCard } from "@/components/parent/parent-push-notifications-card";
import { SettingsAccordionItem } from "@/components/ui/settings-accordion-item";
import {
  getFirebaseAuth,
  getFirebaseDb,
  getFirebaseFunctions,
} from "@/lib/firebase/client-app";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";
import { useDashboardRefetchOnFocus } from "@/lib/firebase/use-dashboard-refetch-on-focus";
import { formatKrPhoneDisplay } from "@/lib/phone/kr-phone";
import { octomoPhoneKey } from "@/lib/phone/octomo-phone-key";
import { buildDashboardHeaderProfile } from "@/lib/ui/dashboard-header-profile";
import { academyLabelForGreeting } from "@/lib/ui/dashboard-greetings";
import { isLikelyIos, isStandaloneDisplayMode } from "@/lib/platform/ios-pwa";
import { useRoleLogout } from "@/lib/auth/use-role-logout";import { LegalLinks } from "@/components/legal/legal-links";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

export default function ParentSettingsPage() {
  const router = useRouter();
  const { profile: authProfile, refreshProfile } = useAuthProfile();
  const [iosModalOpen, setIosModalOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const {
    logout: onLogout,
    logoutBusy,
    logoutModal,
  } = useRoleLogout({
    redirectTo: "/login/parent",
    role: "parent",
  });
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [phoneSheetOpen, setPhoneSheetOpen] = useState(false);
  const [phoneMessage, setPhoneMessage] = useState<string | null>(null);
  const [loginId, setLoginId] = useState("");
  const [attnId, setAttnId] = useState("");
  const [authProvider, setAuthProvider] = useState<string>("");
  const [googleEmail, setGoogleEmail] = useState<string>("");
  const [googleLinked, setGoogleLinked] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);
  /** undefined: 아직 로딩, null: 기본 학원 없음 */
  const [primaryAcademyId, setPrimaryAcademyId] = useState<
    string | null | undefined
  >(undefined);
  const [academyName, setAcademyName] = useState<string | null>(null);

  useEffect(() => {
    const auth = getFirebaseAuth();
    let cancelled = false;
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setPrimaryAcademyId(undefined);
        setAcademyName(null);
        return;
      }
      try {
        await user.getIdToken();
        const fn = httpsCallable(
          getFirebaseFunctions(),
          "getParentActivationState",
        );
        const res = await fn({});
        const data = res.data as { primaryAcademyId?: string | null };
        const aid = data?.primaryAcademyId?.trim() || null;
        if (!cancelled) {
          setPrimaryAcademyId(aid);
          if (!aid) setAcademyName(null);
        }
      } catch {
        if (!cancelled) {
          setPrimaryAcademyId(null);
          setAcademyName(null);
        }
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  useEffect(() => {
    if (!primaryAcademyId) return;
    let cancelled = false;
    void (async () => {
      try {
        const db = getFirebaseDb();
        const snap = await getDoc(doc(db, "academies", primaryAcademyId));
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
  }, [primaryAcademyId]);

  const loadParentMember = useCallback(async () => {
    if (!primaryAcademyId) return;
    const uid = getFirebaseAuth().currentUser?.uid;
    if (!uid) return;
    const db = getFirebaseDb();
    const snap = await getDoc(doc(db, "academies", primaryAcademyId, "parents", uid));
    const d = snap.data();
    setDisplayName(typeof d?.displayName === "string" ? d.displayName : "");
    const storedPhone = typeof d?.phone === "string" ? d.phone : "";
    setPhone(formatKrPhoneDisplay(storedPhone));
    setPhoneVerified(octomoPhoneKey(storedPhone) !== "" && d?.phoneVerifiedKey === octomoPhoneKey(storedPhone));
    setLoginId(typeof d?.loginId === "string" ? d.loginId : "");
    setAttnId(typeof d?.attnId === "string" ? d.attnId : "");
    setAuthProvider(typeof d?.authProvider === "string" ? d.authProvider : "");
    setGoogleEmail(typeof d?.googleEmail === "string" ? d.googleEmail : "");
    setGoogleLinked(d?.googleLinked === true);
  }, [primaryAcademyId]);

  const { refresh: refreshParentMember } = useDashboardRefetchOnFocus(loadParentMember, [
    primaryAcademyId,
  ]);

  const onSaveProfile = useCallback(async () => {
    setProfileError(null);
    setProfileSaved(false);
    setProfileBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "updateParentProfile");
      // 번호는 [번호 바꾸기](문자 확인 필수)로만 바꾼다 — 여기서는 이름만
      await fn({ displayName: displayName.trim() });
      await refreshProfile();
      setProfileSaved(true);
    } catch (e) {
      setProfileError(
        e instanceof FirebaseError ? e.message : "저장에 실패했습니다.",
      );
    } finally {
      setProfileBusy(false);
    }
  }, [displayName, refreshProfile]);

  const affiliationLabel =
    primaryAcademyId === undefined
      ? "불러오는 중…"
      : primaryAcademyId === null
        ? "연결된 학원 없음"
        : academyLabelForGreeting(academyName, primaryAcademyId);

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

  const openIosHint = () => {
    if (!isLikelyIos()) {
      setToast(
        "iPhone·iPad Safari가 아닌 경우 이 안내는 필요하지 않을 수 있습니다.",
      );
      return;
    }
    if (isStandaloneDisplayMode()) {
      setToast("이미 홈 화면 앱으로 실행 중입니다.");
      return;
    }
    setToast(null);
    setIosModalOpen(true);
  };

  return (
    <div className="min-h-[100dvh] bg-background px-4 pb-28">
      <div className="mx-auto max-w-lg">
        <DashboardRoleHeader
          title="사용자 설정"
          affiliationLabel={affiliationLabel}
          menuIntro={
            <span className="text-neutral-600 dark:text-neutral-400">
              프로필, 비밀번호, Google 연동, 알림 및 기기 안내를 관리합니다.
            </span>
          }
          showBack
          onBackAction={() => router.back()}
          backAriaLabel="학부모 대시보드로 돌아가기"
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

        {toast ? (
          <p className="mb-4 rounded-xl bg-amber-500/15 px-3 py-2 text-center text-xs text-amber-900">
            {toast}
          </p>
        ) : null}

        <div className="space-y-4 mt-[26px]">
          <SettingsAccordionItem title="프로필">
            <div>
              <label
                className="mb-1 block text-xs font-medium text-neutral-600"
                htmlFor="p-dn"
              >
                표시 이름
              </label>
              <input
                id="p-dn"
                className={inputClass}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={60}
                disabled={profileBusy || logoutBusy}
                autoComplete="name"
              />
            </div>
            <div>
              <label
                className="mb-1 block text-xs font-medium text-neutral-600"
                htmlFor="p-phone"
              >
                전화번호
              </label>
              <div className="flex items-center gap-2">
                <p
                  id="p-phone"
                  className="min-w-0 flex-1 truncate rounded-2xl border border-neutral-300/60 bg-white/30 px-4 py-3 font-mono text-sm text-foreground dark:border-white/12"
                >
                  {phone || "없음"}
                </p>
                <button
                  type="button"
                  disabled={profileBusy || logoutBusy || !primaryAcademyId}
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
            {profileError ? (
              <p className="text-sm text-red-700">{profileError}</p>
            ) : null}
            {profileSaved ? (
              <p className="text-sm text-emerald-800">저장되었습니다.</p>
            ) : null}
            <button
              type="button"
              disabled={profileBusy}
              onClick={() => void onSaveProfile()}
              className="w-full rounded-2xl bg-[#222] py-2.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950 disabled:opacity-60"
            >
              {profileBusy ? "저장 중…" : "프로필 저장"}
            </button>
          </SettingsAccordionItem>
          {primaryAcademyId ? (
            <ParentLoginIdSettingsCard
              attnId={attnId}
              currentLoginId={loginId || attnId}
              requirePassword={authProvider !== "google"}
              disabled={profileBusy || logoutBusy}
              onSavedAction={setLoginId}
              defaultCollapsed
            />
          ) : null}
          {primaryAcademyId ? (
            <ParentPasswordSettingsCard
              disabled={profileBusy || logoutBusy}
              registerMode={authProvider === "google"}
              defaultCollapsed
              onSavedAction={refreshParentMember}
            />
          ) : null}
          {primaryAcademyId ? (
            <ParentGoogleLinkCard
              memberAuthProvider={authProvider}
              loginId={loginId || attnId}
              googleLinked={googleLinked}
              googleEmail={googleEmail}
              defaultCollapsed
              onLinkedAction={refreshParentMember}
            />
          ) : null}
          <ParentPushNotificationsCard defaultCollapsed />
          <SettingsAccordionItem title="iOS (Safari)">
            <p className="text-[11px] leading-relaxed text-neutral-600">
              푸시를 안정적으로 쓰려면 홈 화면에 추가한 뒤 해당 아이콘으로 여는
              것이 좋습니다. 안내를 다시 보려면 아래를 누르세요.
            </p>
            <button
              type="button"
              onClick={openIosHint}
              className="w-full rounded-2xl border border-neutral-300/80 bg-white/70 py-2.5 text-sm font-medium text-neutral-800 hover:bg-white"
            >
              iOS 안내 다시 보기
            </button>
          </SettingsAccordionItem>
        </div>

        <IosPwaHintModal
          open={iosModalOpen}
          onCloseAction={() => setIosModalOpen(false)}
          onConfirmAction={async (dontShowAgain) => {
            if (!dontShowAgain) return;
            const u = getFirebaseAuth().currentUser;
            if (!u) return;
            await setDoc(
              doc(getFirebaseDb(), "users", u.uid),
              { attn_hide_ios_pwa_hint: true },
              { merge: true },
            );
          }}
        />
        <LegalLinks className="mt-6" />
      </div>

      {phoneSheetOpen ? (
        <PhoneChangeSheet
          title="번호 바꾸기"
          intro="새 번호로 문자 확인을 마치면 계정 번호와 학원에 연결된 자녀의 보호자 번호가 함께 바뀌어요."
          initialPhone=""
          currentPhone={phone}
          currentVerified={phoneVerified}
          submitAction={async (nextPhone, proof) => {
            const res = await httpsCallable(getFirebaseFunctions(), "updateParentProfile")({
              phone: nextPhone,
              phoneProof: proof,
            });
            const linkedCount = (res.data as { linkedCount?: number }).linkedCount ?? 0;
            return linkedCount > 0
              ? `번호를 확인해 바꿨어요. 자녀 ${linkedCount}명과 새로 연결됐어요.`
              : "번호를 확인해 바꿨어요.";
          }}
          onDoneAction={(message) => {
            setPhoneSheetOpen(false);
            setPhoneMessage(message);
            void refreshParentMember();
            void refreshProfile();
          }}
          onCloseAction={() => setPhoneSheetOpen(false)}
        />
      ) : null}
      <DashboardBottomScrim />
      {logoutModal}
    </div>
  );
}
