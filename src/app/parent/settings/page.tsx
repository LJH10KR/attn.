"use client";

import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
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

export default function ParentSettingsPage() {
  const router = useRouter();
  const authProfile = useAuthProfile();
  const [iosModalOpen, setIosModalOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [logoutBusy, setLogoutBusy] = useState(false);
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
    const unsub = onSnapshot(
      doc(db, "academies", primaryAcademyId),
      (snap) => {
        const n = snap.data()?.name;
        setAcademyName(typeof n === "string" ? n : null);
      },
      () => setAcademyName(null),
    );
    return () => unsub();
  }, [primaryAcademyId]);

  const affiliationLabel =
    primaryAcademyId === undefined
      ? "불러오는 중…"
      : primaryAcademyId === null
        ? "연결된 학원 없음"
        : academyLabelForGreeting(academyName, primaryAcademyId);

  const onLogout = useCallback(async () => {
    setLogoutBusy(true);
    try {
      await signOut(getFirebaseAuth());
    } finally {
      setLogoutBusy(false);
      router.replace("/login/parent");
    }
  }, [router]);

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
              알림 및 기기 안내를 관리합니다.
            </span>
          }
          showBack
          onBack={() => router.push("/parent")}
          backAriaLabel="학부모 대시보드로 돌아가기"
          onHome={() => router.push("/")}
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
          onLogout={() => void onLogout()}
          logoutBusy={logoutBusy}
          profile={authProfile}
        />

        {toast ? (
          <p className="mb-4 rounded-xl bg-amber-500/15 px-3 py-2 text-center text-xs text-amber-900">
            {toast}
          </p>
        ) : null}

        <div className="space-y-4 mt-5">
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
    </div>
  );
}
