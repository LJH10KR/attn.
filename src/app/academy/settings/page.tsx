"use client";

import { onAuthStateChanged } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { PinPadModal } from "@/components/academy/pin-pad-modal";
import { AttnTabLogo } from "@/components/dashboard/attn-tab-logo";
import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";
import { DashboardRoleHeader } from "@/components/dashboard/dashboard-role-header";
import type { AcademyKioskSettingsPublic } from "@/lib/firebase/attn-schema";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";
import { fetchIsOwner } from "@/lib/firebase/owner-profile";
import { FirebaseError } from "firebase/app";
import { AcademyPortalPasswordSettingsCard } from "@/components/account/password-settings-cards";
import { SlideSwitch } from "@/components/ui/slide-switch";

const glassCard = "glass-card";

function callableMessage(err: unknown, fallback: string): string {
  if (err instanceof FirebaseError && err.message) return err.message;
  return fallback;
}

function AcademySettingsInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { profile: authProfile } = useAuthProfile();
  const academyId = searchParams.get("id")?.trim() ?? "";
  const [gate, setGate] = useState<"loading" | "auth" | "forbidden" | "ok">("loading");
  const [settings, setSettings] = useState<AcademyKioskSettingsPublic | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exitPinModal, setExitPinModal] = useState<"set" | "change" | null>(null);
  const [exitPinStep, setExitPinStep] = useState<"current" | "new" | "confirm">("new");
  const [pinModalError, setPinModalError] = useState<string | null>(null);
  const currentExitPinRef = useRef("");
  const pendingNewPinRef = useRef<string | null>(null);

  const loadSettings = useCallback(async () => {
    if (!academyId) return;
    setLoadError(null);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "getAcademyKioskSettings");
      const res = await fn({ academyId });
      const data = res.data as { settings?: AcademyKioskSettingsPublic };
      setSettings(data.settings ?? null);
    } catch (err) {
      setLoadError(callableMessage(err, "설정을 불러오지 못했습니다."));
    }
  }, [academyId]);

  useEffect(() => {
    if (!isFirebaseConfigured()) {
      setGate("auth");
      return;
    }
    const auth = getFirebaseAuth();
    return onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setGate("auth");
        return;
      }
      if (!academyId) {
        setGate("forbidden");
        return;
      }
      try {
        const token = await user.getIdTokenResult();
        const role = token.claims.role;
        const claimAcademy = token.claims.academyId;
        const isPortal = role === "academy" && claimAcademy === academyId;
        const ownerOk = role !== "academy" && (await fetchIsOwner(user.uid));
        if (!isPortal && !ownerOk) {
          setGate("forbidden");
          return;
        }
        setGate("ok");
        await loadSettings();
      } catch {
        setGate("forbidden");
      }
    });
  }, [academyId, loadSettings]);

  const updateSettings = useCallback(
    async (
      payload: Record<string, unknown>,
      opts?: { errorTarget?: "toast" | "pinModal" },
    ) => {
      if (!academyId) return;
      setBusy(true);
      if (opts?.errorTarget !== "pinModal") {
        setToast(null);
      }
      try {
        const fn = httpsCallable(getFirebaseFunctions(), "updateAcademyKioskSettings");
        const res = await fn({ academyId, ...payload });
        const data = res.data as { settings?: AcademyKioskSettingsPublic };
        setSettings(data.settings ?? null);
        setPinModalError(null);
        setToast("저장되었습니다.");
        return true;
      } catch (err) {
        const msg = callableMessage(err, "저장에 실패했습니다.");
        if (opts?.errorTarget === "pinModal") {
          setPinModalError(msg);
        } else {
          setToast(msg);
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [academyId],
  );

  if (gate === "loading") {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center">
        <p className="text-sm text-neutral-500">불러오는 중…</p>
      </div>
    );
  }

  if (gate === "auth") {
    router.replace("/login");
    return null;
  }

  if (gate === "forbidden" || !academyId) {
    return (
      <div className="min-h-[100dvh] bg-background px-4 py-16 flex flex-col items-center justify-center">
        <p className="text-sm text-neutral-600 text-center">학원 설정에 접근할 수 없습니다.</p>
        <Link href="/academy" className="mt-4 text-sm underline">
          대시보드로
        </Link>
      </div>
    );
  }

  const backHref = `/academy?id=${encodeURIComponent(academyId)}`;

  return (
    <div className="min-h-[100dvh] bg-background pb-28">
      <DashboardRoleHeader
        title="학원 설정"
        affiliationLabel="출석 키오스크"
        profile={authProfile}
        showBack
        onBackAction={() => router.push(backHref)}
        backAriaLabel="학원 대시보드로"
        showBellOnTitle={false}
        showBellInBottomBar={false}
        onHomeAction={() => router.push("/")}
        onLogoutAction={() => router.push(backHref)}
        logoutLabel="닫기"
        bottomTabs={[
          {
            id: "home",
            label: "요약",
            showLabel: false,
            iconAction: (active: boolean) => <AttnTabLogo active={active} />,
            active: true,
            onSelectAction: () => router.push(backHref),
          },
        ]}
      />

      <main className="mx-auto max-w-lg px-4 pt-2 space-y-4">
        {loadError ? (
          <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
        ) : null}
        {toast ? (
          <p className="text-sm text-center text-neutral-600 dark:text-neutral-400">{toast}</p>
        ) : null}

        <AcademyPortalPasswordSettingsCard academyId={academyId} disabled={busy} />

        <section className={`p-5 ${glassCard}`}>
          <h2 className="text-sm font-semibold text-foreground">키오스크 종료 PIN</h2>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            출석 키오스크를 끌 때 입력하는 4자리 PIN입니다.
          </p>
          {settings?.exitPinLocked ? (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">
              종료 PIN이 잠겼습니다. 아래에서 잠금을 해제한 뒤 PIN을 다시 설정해 주세요.
            </p>
          ) : null}
          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              disabled={busy}
              className="rounded-2xl bg-[#222] px-4 py-3 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950"
              onClick={() => {
                setExitPinModal(settings?.exitPinConfigured ? "change" : "set");
                setExitPinStep(settings?.exitPinConfigured ? "current" : "new");
                pendingNewPinRef.current = null;
                setPinModalError(null);
                currentExitPinRef.current = "";
              }}
            >
              {settings?.exitPinConfigured ? "종료 PIN 변경" : "종료 PIN 설정"}
            </button>
            {settings?.exitPinLocked ? (
              <button
                type="button"
                disabled={busy}
                className="rounded-2xl border border-neutral-200 px-4 py-3 text-sm font-medium dark:border-white/15"
                onClick={() => void updateSettings({ unlockExitPinLock: true })}
              >
                종료 PIN 잠금 해제
              </button>
            ) : null}
          </div>
        </section>

        <section className={`p-5 ${glassCard}`}>
          <h2 className="text-sm font-semibold text-foreground">출석 PIN</h2>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            켜면 학부모가 자녀별 출석 PIN을 설정해야 키오스크에서 출석할 수 있습니다.
          </p>
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-sm text-neutral-800 dark:text-neutral-200">
              {settings?.requireStudentCheckInPin ? "출석 PIN 사용 중" : "출석 PIN 사용 안 함"}
            </span>
            <SlideSwitch
              checked={settings?.requireStudentCheckInPin ?? false}
              disabled={busy || !settings}
              ariaLabel="출석 시 PIN 사용"
              onCheckedChangeAction={(checked) =>
                void updateSettings({ requireStudentCheckInPin: checked })
              }
            />
          </div>
        </section>
      </main>

      <PinPadModal
        open={Boolean(exitPinModal)}
        phaseKey={exitPinModal ? `${exitPinModal}-${exitPinStep}` : "closed"}
        title={
          exitPinStep === "current"
            ? "기존 종료 PIN"
            : exitPinStep === "new"
              ? "새 종료 PIN"
              : "새 종료 PIN 확인"
        }
        description="숫자 4자리를 입력해 주세요."
        error={pinModalError}
        busy={busy}
        busyTitle="PIN 저장 중..."
        busyDescription="잠시만 기다려 주세요."
        onCloseAction={() => {
          if (!busy) {
            setExitPinModal(null);
            setPinModalError(null);
          }
        }}
        onCompleteAction={(pin) => {
          if (exitPinStep === "current") {
            currentExitPinRef.current = pin;
            setExitPinStep("new");
            return;
          }
          if (exitPinStep === "new") {
            pendingNewPinRef.current = pin;
            setExitPinStep("confirm");
            return;
          }
          if (pin !== pendingNewPinRef.current) {
            setPinModalError("PIN이 일치하지 않습니다.");
            setExitPinStep("new");
            pendingNewPinRef.current = null;
            return;
          }
          void (async () => {
            const ok = await updateSettings(
              {
                newExitPin: pin,
                ...(exitPinModal === "change"
                  ? { currentExitPin: currentExitPinRef.current }
                  : {}),
              },
              { errorTarget: "pinModal" },
            );
            if (ok) {
              setExitPinModal(null);
              currentExitPinRef.current = "";
              pendingNewPinRef.current = null;
            }
          })();
        }}
      />

      <DashboardBottomScrim />
    </div>
  );
}

export default function AcademySettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-[100dvh] bg-background flex items-center justify-center">
          <p className="text-sm text-neutral-500">불러오는 중…</p>
        </div>
      }
    >
      <AcademySettingsInner />
    </Suspense>
  );
}
