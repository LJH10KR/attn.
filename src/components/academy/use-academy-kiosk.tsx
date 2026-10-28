"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { KioskStudentRow } from "@/components/academy/academy-kiosk-panel";
import { PinPadModal } from "@/components/academy/pin-pad-modal";
import { verifyKioskExitPinAndClear } from "@/lib/academy/kiosk-exit";
import { KIOSK_MODE_CHANGED_EVENT, notifyKioskModeChanged } from "@/lib/academy/kiosk-mode-events";
import {
  activeKioskAcademyId,
  kioskModeStorageKey,
  loadKioskStudentRows,
} from "@/lib/academy/kiosk-student-rows";
import type { AcademyKioskSettingsPublic } from "@/lib/firebase/attn-schema";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";

function callableMessage(err: unknown, fallback: string): string {
  if (err instanceof FirebaseError && err.message) return err.message;
  return fallback;
}

export type AcademyKioskState = {
  /** 이 탭에서 키오스크가 켜진 학원(주소의 학원과 다를 수 있음) */
  activeAcademyId: string | null;
  settings: AcademyKioskSettingsPublic | null;
  rows: KioskStudentRow[];
  rowsBusy: boolean;
  busy: boolean;
  toast: string | null;
  /** 확인 후 켜기 — 종료 PIN이 없거나 잠겼으면 안내만 */
  requestOn: () => void;
  /** 종료 PIN 확인 후 끄기 */
  requestOff: () => void;
  /** 켜기 확인·종료 PIN 모달 */
  modals: ReactNode;
};

/**
 * 출석 키오스크(지금 방식: 원장·출결 권한 직원 세션 + 탭 단위 sessionStorage) — 학원 공통 레이아웃에서 한 번만 쓴다.
 * `settingsEnabled`가 거짓이면 설정을 읽지 않는다(권한 없는 직원).
 */
export function useAcademyKiosk(academyId: string, settingsEnabled: boolean): AcademyKioskState {
  const [activeAcademyId, setActiveAcademyId] = useState<string | null>(() => activeKioskAcademyId());
  const [settings, setSettings] = useState<AcademyKioskSettingsPublic | null>(null);
  const [rows, setRows] = useState<KioskStudentRow[]>([]);
  const [rowsBusy, setRowsBusy] = useState(false);
  const [enableConfirmOpen, setEnableConfirmOpen] = useState(false);
  const [exitPinOpen, setExitPinOpen] = useState(false);
  const [exitPinError, setExitPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setActiveAcademyId(activeKioskAcademyId());
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener(KIOSK_MODE_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener(KIOSK_MODE_CHANGED_EVENT, sync);
    };
  }, []);

  const loadSettings = useCallback(async (): Promise<AcademyKioskSettingsPublic | null> => {
    let next: AcademyKioskSettingsPublic | null = null;
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "getAcademyKioskSettings");
      const res = await fn({ academyId });
      next = (res.data as { settings?: AcademyKioskSettingsPublic }).settings ?? null;
    } catch {
      /* 권한·네트워크 — 설정 없음으로 취급 */
    }
    setSettings(next);
    return next;
  }, [academyId]);

  const kioskHere = activeAcademyId === academyId;

  useEffect(() => {
    if (settingsEnabled || kioskHere) void loadSettings();
  }, [settingsEnabled, kioskHere, loadSettings]);

  useEffect(() => {
    if (!kioskHere) return;
    let cancelled = false;
    setRowsBusy(true);
    void loadKioskStudentRows(academyId)
      .then((next) => {
        if (!cancelled) setRows(next);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setRowsBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [academyId, kioskHere]);

  const persist = useCallback(
    (on: boolean) => {
      try {
        if (on) sessionStorage.setItem(kioskModeStorageKey(academyId), "1");
        else sessionStorage.removeItem(kioskModeStorageKey(academyId));
      } catch {
        /* ignore */
      }
      notifyKioskModeChanged();
    },
    [academyId],
  );

  const requestOn = useCallback(() => {
    void (async () => {
      // 화면에 들어오자마자 누르면 설정을 아직 못 받았을 수 있음 — 받아 보고 판단
      const current = settings ?? (await loadSettings());
      if (!current?.exitPinConfigured) {
        setToast("전체설정에서 키오스크 종료 PIN을 먼저 설정해 주세요.");
        return;
      }
      if (current.exitPinLocked) {
        setToast("종료 PIN이 잠겼습니다. 전체설정에서 잠금을 해제해 주세요.");
        return;
      }
      setEnableConfirmOpen(true);
    })();
  }, [settings, loadSettings]);

  const confirmOn = useCallback(() => {
    setEnableConfirmOpen(false);
    persist(true);
    setToast(null);
  }, [persist]);

  const requestOff = useCallback(() => {
    void (async () => {
      // 설정을 받기 전에 누르면 PIN 없이 꺼지지 않도록 받아 보고 판단
      const current = settings ?? (await loadSettings());
      if (current && !current.exitPinConfigured) {
        persist(false);
        return;
      }
      setExitPinError(null);
      setExitPinOpen(true);
    })();
  }, [persist, settings, loadSettings]);

  const verifyExitPinAndOff = useCallback(
    async (pin: string) => {
      setBusy(true);
      setExitPinError(null);
      try {
        await verifyKioskExitPinAndClear(academyId, pin);
        setExitPinOpen(false);
        notifyKioskModeChanged();
      } catch (err) {
        setExitPinError(callableMessage(err, "PIN 확인에 실패했습니다."));
      } finally {
        setBusy(false);
        void loadSettings();
      }
    },
    [academyId, loadSettings],
  );

  const modals = (
    <>
      {enableConfirmOpen ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-xl dark:bg-neutral-900">
            <p className="text-lg font-semibold text-foreground">출석 키오스크</p>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              키오스크 모드에서는 학생 검색 후 출석만 처리할 수 있습니다. 계속할까요?
            </p>
            <div className="mt-6 flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium dark:border-white/15"
                onClick={() => setEnableConfirmOpen(false)}
              >
                취소
              </button>
              <button
                type="button"
                className="flex-1 rounded-2xl bg-[#222] py-3 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950"
                onClick={confirmOn}
              >
                켜기
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <PinPadModal
        open={exitPinOpen}
        phaseKey={exitPinOpen ? "exit" : "exit-closed"}
        title="키오스크 종료 PIN"
        description="키오스크를 끄려면 종료 PIN 4자리를 입력해 주세요."
        error={exitPinError}
        busy={busy}
        busyTitle="키오스크 종료 중..."
        busyDescription="잠시만 기다려 주세요."
        onCloseAction={() => {
          if (!busy) {
            setExitPinOpen(false);
            setExitPinError(null);
          }
        }}
        onCompleteAction={(pin) => void verifyExitPinAndOff(pin)}
      />
    </>
  );

  return {
    activeAcademyId,
    settings,
    rows,
    rowsBusy,
    busy,
    toast,
    requestOn,
    requestOff,
    modals,
  };
}
