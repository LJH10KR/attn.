"use client";

import { onAuthStateChanged } from "firebase/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { HomeTabIcon } from "@/components/dashboard/attn-tab-logo";
import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";
import { DashboardRoleHeader } from "@/components/dashboard/dashboard-role-header";
import { OwnerPasswordSettingsCard } from "@/components/account/password-settings-cards";
import { OwnerGoogleLinkCard } from "@/components/owner/owner-google-link-card";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { COLLECTIONS } from "@/lib/firebase/attn-schema";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client-app";
import { buildDashboardHeaderProfile } from "@/lib/ui/dashboard-header-profile";
import { useRoleLogout } from "@/lib/auth/use-role-logout";
import { fetchIsOwner } from "@/lib/firebase/owner-profile";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";

const glassCard = "glass-card";

export default function OwnerSettingsPage() {
  const router = useRouter();
  const { profile: authProfile } = useAuthProfile();
  const [gate, setGate] = useState<"loading" | "auth" | "forbidden" | "ok">(
    "loading",
  );
  const { logout: onLogout, logoutBusy, logoutModal } = useRoleLogout({
    redirectTo: "/login/owner",
    role: "owner",
  });
  const configured = isFirebaseConfigured();
  const [ownerDisplayName, setOwnerDisplayName] = useState<string | null>(null);
  const [ownerPhone, setOwnerPhone] = useState<string | null>(null);

  useEffect(() => {
    if (!configured) {
      setGate("auth");
      return;
    }
    const auth = getFirebaseAuth();
    return onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setGate("auth");
        return;
      }
      setGate("loading");
      const isOwner = await fetchIsOwner(user.uid);
      setGate(isOwner ? "ok" : "forbidden");
    });
  }, [configured]);

  useEffect(() => {
    if (!configured || gate !== "auth") return;
    router.replace("/login/owner");
  }, [configured, gate, router]);

  useEffect(() => {
    if (!configured || gate !== "ok") return;
    const uid = getFirebaseAuth().currentUser?.uid;
    if (!uid) return;
    const db = getFirebaseDb();
    return onSnapshot(doc(db, COLLECTIONS.users, uid), (snap) => {
      const d = snap.data();
      setOwnerDisplayName(typeof d?.displayName === "string" ? d.displayName : null);
      const rawPhone = typeof d?.phone === "string" ? d.phone.trim() : "";
      setOwnerPhone(rawPhone || null);
    });
  }, [configured, gate]);

  const headerProfile = useMemo(
    () =>
      buildDashboardHeaderProfile(authProfile, {
        displayName: ownerDisplayName,
        phone: ownerPhone,
      }),
    [authProfile, ownerDisplayName, ownerPhone],
  );

  if (!configured) {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center px-4">
        <p className="text-sm text-neutral-600">Firebase 설정이 필요합니다.</p>
      </div>
    );
  }

  if (gate === "loading") {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center">
        <p className="text-sm text-neutral-500">불러오는 중…</p>
      </div>
    );
  }

  if (gate === "forbidden") {
    return (
      <div className="min-h-[100dvh] bg-background px-4 py-16 flex flex-col items-center justify-center">
        <div className={`w-full max-w-md p-8 text-center ${glassCard}`}>
          <h1 className="text-lg font-semibold text-foreground">
            오너 전용 페이지
          </h1>
          <p className="mt-3 text-sm text-neutral-600">
            오너로 등록된 계정만 이용할 수 있습니다.
          </p>
          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Link
              href="/signup"
              className="inline-flex justify-center rounded-2xl bg-[#222] dark:bg-neutral-100 px-6 py-3 text-sm font-medium text-white dark:text-neutral-950"
            >
              오너 회원가입
            </Link>
            <Link
              href="/login/owner"
              className="inline-flex justify-center rounded-2xl border border-neutral-300/70 bg-white/50 px-6 py-3 text-sm font-medium text-foreground"
            >
              로그인
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (gate !== "ok") {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center">
        <p className="text-sm text-neutral-500">로그인 페이지로 이동합니다…</p>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background px-4 pb-28">
      <div className="mx-auto max-w-lg">
        <DashboardRoleHeader
          title="사용자 설정"
          affiliationLabel="오너 계정"
          menuIntro={
            <span className="text-neutral-600 dark:text-neutral-400">
              Google 연동, 비밀번호 등 계정을 관리합니다.
            </span>
          }
          showBack
          onBackAction={() => router.back()}
          backAriaLabel="오너 대시보드로 돌아가기"
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
          <OwnerPasswordSettingsCard disabled={logoutBusy} defaultCollapsed />
          <OwnerGoogleLinkCard defaultCollapsed />
        </div>
      </div>

      <DashboardBottomScrim />
      {logoutModal}
    </div>
  );
}
