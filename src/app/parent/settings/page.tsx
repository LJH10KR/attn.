"use client";

import { FirebaseError } from "firebase/app";
import { onAuthStateChanged } from "firebase/auth";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AttnTabLogo } from "@/components/dashboard/attn-tab-logo";
import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";
import { DashboardRoleHeader } from "@/components/dashboard/dashboard-role-header";
import { IosPwaHintModal } from "@/components/parent/ios-pwa-hint-modal";
import { MemberPasswordSettingsCard } from "@/components/account/password-settings-cards";
import { ParentGoogleLinkCard } from "@/components/parent/parent-google-link-card";
import { ParentPushNotificationsCard } from "@/components/parent/parent-push-notifications-card";
import {
  getFirebaseAuth,
  getFirebaseDb,
  getFirebaseFunctions,
} from "@/lib/firebase/client-app";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";
import { academyLabelForGreeting } from "@/lib/ui/dashboard-greetings";
import { isLikelyIos, isStandaloneDisplayMode } from "@/lib/platform/ios-pwa";
import { useRoleLogout } from "@/lib/auth/use-role-logout";

const glassCard = "glass-card";

export default function ParentSettingsPage() {
  const router = useRouter();
  const authProfile = useAuthProfile();
  const [iosModalOpen, setIosModalOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const { logout: onLogout, logoutBusy, logoutModal } = useRoleLogout({
    redirectTo: "/login/parent",
    role: "parent",
  });
  const [displayName, setDisplayName] = useState("");
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
    const db = getFirebaseDb();
    const uid = getFirebaseAuth().currentUser?.uid;
    const unsubAcademy = onSnapshot(
      doc(db, "academies", primaryAcademyId),
      (snap) => {
        const n = snap.data()?.name;
        setAcademyName(typeof n === "string" ? n : null);
      },
      () => setAcademyName(null),
    );
    const unsubParent = uid
      ? onSnapshot(
          doc(db, "academies", primaryAcademyId, "parents", uid),
          (snap) => {
            const d = snap.data();
            setDisplayName(
              typeof d?.displayName === "string" ? d.displayName : "",
            );
            setLoginId(typeof d?.loginId === "string" ? d.loginId : "");
            setAttnId(typeof d?.attnId === "string" ? d.attnId : "");
            setAuthProvider(typeof d?.authProvider === "string" ? d.authProvider : "");
            setGoogleEmail(typeof d?.googleEmail === "string" ? d.googleEmail : "");
            setGoogleLinked(d?.googleLinked === true);
          },
        )
      : () => {};
    return () => {
      unsubAcademy();
      unsubParent();
    };
  }, [primaryAcademyId]);

  const onSaveProfile = useCallback(async () => {
    setProfileError(null);
    setProfileSaved(false);
    setProfileBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "updateParentProfile");
      await fn({ displayName: displayName.trim() });
      setProfileSaved(true);
    } catch (e) {
      setProfileError(
        e instanceof FirebaseError ? e.message : "저장에 실패했습니다.",
      );
    } finally {
      setProfileBusy(false);
    }
  }, [displayName]);

  const affiliationLabel =
    primaryAcademyId === undefined
      ? "불러오는 중…"
      : primaryAcademyId === null
        ? "연결된 학원 없음"
        : academyLabelForGreeting(academyName, primaryAcademyId);

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
          onBackAction={() => router.push("/parent")}
          backAriaLabel="학부모 대시보드로 돌아가기"
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

        {toast ? (
          <p className="mb-4 rounded-xl bg-amber-500/15 px-3 py-2 text-center text-xs text-amber-900">
            {toast}
          </p>
        ) : null}

        <div className="space-y-4 mt-5">
          <section className={`p-4 ${glassCard}`}>
            <h2 className="text-sm font-semibold text-foreground">프로필</h2>
            <p className="mt-2 text-[11px] text-neutral-600">
              로그인 ID는 변경할 수 없습니다.
            </p>
            <p className="mt-3 text-xs font-medium text-neutral-500">로그인 ID</p>
            <p className="font-mono text-sm text-foreground">{loginId || attnId || "—"}</p>
            {loginId && attnId && loginId !== attnId ? (
              <p className="mt-2 text-[11px] text-neutral-500">
                관리 번호(attn): <span className="font-mono">{attnId}</span>
              </p>
            ) : null}
            <label
              className="mt-4 mb-1 block text-xs font-medium text-neutral-600"
              htmlFor="p-dn"
            >
              표시 이름
            </label>
            <input
              id="p-dn"
              className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-2.5 text-sm outline-none focus:border-[#4a90e2]/50"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={60}
            />
            {profileError ? (
              <p className="mt-2 text-sm text-red-700">{profileError}</p>
            ) : null}
            {profileSaved ? (
              <p className="mt-2 text-sm text-emerald-800">저장되었습니다.</p>
            ) : null}
            <button
              type="button"
              disabled={profileBusy}
              onClick={() => void onSaveProfile()}
              className="mt-3 w-full rounded-2xl bg-[#222] py-2.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950 disabled:opacity-60"
            >
              {profileBusy ? "저장 중…" : "이름 저장"}
            </button>
          </section>
          {primaryAcademyId && authProvider !== "google" ? (
            <MemberPasswordSettingsCard
              callableName="updateParentPassword"
              idPrefix="parent"
              description="로그인 ID와 함께 쓰는 비밀번호를 변경합니다. Google 연결 시 본인 확인에도 사용됩니다."
              disabled={profileBusy || logoutBusy}
            />
          ) : null}
          {primaryAcademyId ? (
            <ParentGoogleLinkCard
              memberAuthProvider={authProvider}
              loginId={loginId || attnId}
              googleLinked={googleLinked}
              googleEmail={googleEmail}
            />
          ) : null}
          <ParentPushNotificationsCard />
          <section className={`p-4 ${glassCard}`}>
            <h2 className="text-sm font-semibold text-foreground">
              iOS (Safari)
            </h2>
            <p className="mt-2 text-[11px] leading-relaxed text-neutral-600">
              푸시를 안정적으로 쓰려면 홈 화면에 추가한 뒤 해당 아이콘으로 여는
              것이 좋습니다. 안내를 다시 보려면 아래를 누르세요.
            </p>
            <button
              type="button"
              onClick={openIosHint}
              className="mt-3 w-full rounded-2xl border border-neutral-300/80 bg-white/70 py-2.5 text-sm font-medium text-neutral-800 hover:bg-white"
            >
              iOS 안내 다시 보기
            </button>
          </section>
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
      </div>

      <DashboardBottomScrim />
      {logoutModal}
    </div>
  );
}
