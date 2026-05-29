"use client";

import { useCallback, useEffect, useState } from "react";
import { PinPadModal } from "@/components/academy/pin-pad-modal";
import {
  KIOSK_MODE_CHANGED_EVENT,
  notifyKioskModeChanged,
} from "@/lib/academy/kiosk-mode-events";
import { verifyKioskExitPinAndClear } from "@/lib/academy/kiosk-exit";
import { isKioskModeActive } from "@/lib/academy/kiosk-student-rows";
import { FirebaseError } from "firebase/app";

function callableMessage(err: unknown, fallback: string): string {
  if (err instanceof FirebaseError && err.message) return err.message;
  return fallback;
}

/**
 * 키오스크가 켜진 동안 브라우저 뒤로가기(popstate)로 이전 화면·URL로 빠지는 것을 막습니다.
 * 뒤로가기 시도 시 종료 PIN을 요구합니다.
 */
export function KioskHistoryGuard({ academyId }: { academyId: string }) {
  const [kioskActive, setKioskActive] = useState(() => isKioskModeActive(academyId));
  const [pinOpen, setPinOpen] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const sync = () => setKioskActive(isKioskModeActive(academyId));
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener(KIOSK_MODE_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener(KIOSK_MODE_CHANGED_EVENT, sync);
    };
  }, [academyId]);

  useEffect(() => {
    if (!kioskActive || !academyId) return;

    const state = { attnKioskGuard: academyId };
    const url = window.location.pathname + window.location.search;

    const trap = () => {
      window.history.pushState(state, "", url);
    };

    trap();

    const onPopState = () => {
      if (!isKioskModeActive(academyId)) return;
      trap();
      setPinError(null);
      setPinOpen(true);
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [academyId, kioskActive]);

  const onPinCompleteAction = useCallback(
    async (pin: string) => {
      setBusy(true);
      setPinError(null);
      try {
        await verifyKioskExitPinAndClear(academyId, pin);
        setPinOpen(false);
        setKioskActive(false);
        notifyKioskModeChanged();
      } catch (err) {
        setPinError(callableMessage(err, "PIN 확인에 실패했습니다."));
      } finally {
        setBusy(false);
      }
    },
    [academyId],
  );

  if (!kioskActive && !pinOpen) return null;

  return (
    <PinPadModal
      open={pinOpen}
      phaseKey={pinOpen ? "history-back" : "history-back-closed"}
      title="키오스크 종료 PIN"
      description="뒤로 가기를 사용하려면 종료 PIN 4자리를 입력해 주세요."
      error={pinError}
      busy={busy}
      busyTitle="키오스크 종료 중..."
      busyDescription="잠시만 기다려 주세요."
      onCloseAction={() => {
        if (!busy) {
          setPinOpen(false);
          setPinError(null);
        }
      }}
      onCompleteAction={(pin) => void onPinCompleteAction(pin)}
    />
  );
}
