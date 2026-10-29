"use client";

import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAcademyShell } from "@/components/academy/academy-shell";
import { PinPadModal } from "@/components/academy/pin-pad-modal";
import type { AcademyKioskSettingsPublic } from "@/lib/firebase/attn-schema";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { FirebaseError } from "firebase/app";
import { SlideSwitch } from "@/components/ui/slide-switch";
import { SettingsAccordionItem } from "@/components/ui/settings-accordion-item";
import { OwnerTuitionSettingsCard } from "@/components/owner/owner-tuition-settings-card";
import { OwnerSessionTuitionSettingsCard } from "@/components/owner/owner-session-tuition-settings-card";
import { OwnerAbsenceDeductionSettingsCard } from "@/components/owner/owner-absence-deduction-settings-card";

function callableMessage(err: unknown, fallback: string): string {
  if (err instanceof FirebaseError && err.message) return err.message;
  return fallback;
}

/** 설정 › 전체설정 — 권한(`settings.general`) 확인과 키오스크 중 잠금은 학원 공통 레이아웃이 한다 */
export default function AcademyGeneralSettingsPage() {
  const { academyId, permissions } = useAcademyShell();
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
    void loadSettings();
  }, [loadSettings]);

  const updateSettings = useCallback(
    async (
      payload: Record<string, unknown>,
      opts?: { errorTarget?: "toast" | "pinModal" },
    ) => {
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

  return (
    <>
      <div className="space-y-4">
        {loadError ? (
          <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
        ) : null}
        {toast ? (
          <p className="text-sm text-center text-neutral-600 dark:text-neutral-400">{toast}</p>
        ) : null}

        <SettingsAccordionItem title="키오스크 종료 PIN">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            출석 키오스크를 끌 때 입력하는 4자리 PIN입니다.
          </p>
          {settings?.exitPinLocked ? (
            <p className="text-sm text-red-600 dark:text-red-400">
              종료 PIN이 잠겼습니다. 아래에서 잠금을 해제한 뒤 PIN을 다시 설정해 주세요.
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
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
        </SettingsAccordionItem>

        <SettingsAccordionItem title="출석 PIN">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            켜면 학부모가 자녀별 출석 PIN을 설정해야 키오스크에서 출석할 수 있습니다.
          </p>
          <div className="flex items-center justify-between gap-3">
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
        </SettingsAccordionItem>

        {/* 기본 납부 방식 — 규칙상 수납(청구서)·원생 관리 권한만 읽고 쓴다 */}
        {permissions.can(["billing.invoices", "operations.students"]) ? (
          <OwnerSessionTuitionSettingsCard
            academyId={academyId}
            academyName=""
            disabled={busy}
            defaultCollapsed
          />
        ) : null}

        <OwnerTuitionSettingsCard
          academyId={academyId}
          academyName=""
          disabled={busy}
          defaultCollapsed
        />

        <OwnerAbsenceDeductionSettingsCard
          academyId={academyId}
          disabled={busy}
          defaultCollapsed
        />
      </div>

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
    </>
  );
}
