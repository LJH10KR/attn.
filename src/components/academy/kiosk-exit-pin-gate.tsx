"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, type ReactNode } from "react";
import { PinPadModal } from "@/components/academy/pin-pad-modal";
import { isKioskModeActive } from "@/lib/academy/kiosk-student-rows";
import { verifyKioskExitPinAndClear } from "@/lib/academy/kiosk-exit";
import { FirebaseError } from "firebase/app";

function callableMessage(err: unknown, fallback: string): string {
  if (err instanceof FirebaseError && err.message) return err.message;
  return fallback;
}

export type KioskExitPinGateProps = {
  academyId: string;
  /** PIN 없이 취소 시 이동할 경로(키오스크 유지) */
  cancelHref: string;
  children: ReactNode;
  /** PIN 확인 성공 직후(키오스크 해제 후) */
  onUnlockedAction?: () => void;
};

/**
 * 키오스크가 켜진 상태에서 하위 화면(학원 설정 등)에 들어가기 전에
 * 종료 PIN을 요구합니다. 취소 시 cancelHref로 돌아가며 키오스크는 유지됩니다.
 */
export function KioskExitPinGate({
  academyId,
  cancelHref,
  children,
  onUnlockedAction,
}: KioskExitPinGateProps) {
  const router = useRouter();
  const needsGate = isKioskModeActive(academyId);
  const [unlocked, setUnlocked] = useState(!needsGate);
  const [pinOpen, setPinOpen] = useState(needsGate);
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onCancelAction = useCallback(() => {
    router.replace(cancelHref);
  }, [cancelHref, router]);

  const onPinCompleteAction = useCallback(
    async (pin: string) => {
      setBusy(true);
      setPinError(null);
      try {
        await verifyKioskExitPinAndClear(academyId, pin);
        setUnlocked(true);
        setPinOpen(false);
        onUnlockedAction?.();
      } catch (err) {
        setPinError(callableMessage(err, "PIN 확인에 실패했습니다."));
      } finally {
        setBusy(false);
      }
    },
    [academyId, onUnlockedAction],
  );

  if (unlocked) {
    return <>{children}</>;
  }

  return (
    <>
      <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center px-4">
        <p className="text-center text-sm text-neutral-600 dark:text-neutral-400 max-w-xs">
          키오스크 모드가 켜져 있습니다. 이 화면으로 이동하려면 종료 PIN을 입력해 주세요.
        </p>
      </div>
      <PinPadModal
        open={pinOpen}
        phaseKey="kiosk-exit-gate"
        title="키오스크 종료 PIN"
        description="이동을 계속하려면 종료 PIN 4자리를 입력해 주세요."
        error={pinError}
        busy={busy}
        onCloseAction={onCancelAction}
        onCompleteAction={(pin) => void onPinCompleteAction(pin)}
      />
    </>
  );
}
