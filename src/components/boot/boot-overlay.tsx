"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type HideOptions = {
  /** 채움 완료 연출 없이 바로 닫기 — 예외로 중단되는 경우용 */
  immediate?: boolean;
};

type BootOverlayContextValue = {
  show: () => void;
  hide: (opts?: HideOptions) => void;
  setProgress: (percent: number) => void;
};

const BootOverlayContext = createContext<BootOverlayContextValue | null>(null);

/**
 * 실제로 일어나는 일에 맞춘 대략적인 체크포인트 — 정밀한 퍼센티지가 아니라
 * "이 단계까지는 진짜로 끝났다"는 사실만 반영한다.
 */
export const BOOT_PROGRESS = {
  START: 0,
  AUTH_RESTORED: 35,
  ROLE_RESOLVED: 70,
  DONE: 100,
} as const;

type OverlayPhase = "hidden" | "visible" | "leaving";

/** 어떤 경로도 오버레이를 못 끄는 예외 상황을 대비한 안전장치 */
const FAILSAFE_TIMEOUT_MS = 8000;
/** 100%로 채워지는 모습을 보여준 뒤 사라지기까지의 여유 */
const HIDE_DELAY_MS = 350;

function BootSplash({
  progress,
  leaving,
}: {
  progress: number;
  leaving: boolean;
}) {
  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-background transition-opacity duration-300 ${
        leaving ? "opacity-0" : "opacity-100"
      }`}
      role="status"
      aria-live="polite"
      aria-label="불러오는 중"
    >
      <div
        className="attn-boot-wordmark-wrap"
        style={{ "--boot-progress": progress } as React.CSSProperties}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span className="attn-boot-wordmark-base">attn.</span>
        <span className="attn-boot-wordmark-fill">attn.</span>
      </div>
    </div>
  );
}

export function BootOverlayProvider({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<OverlayPhase>("hidden");
  const [progress, setProgressState] = useState<number>(BOOT_PROGRESS.START);
  const failsafeRef = useRef<number | undefined>(undefined);
  const hideDelayRef = useRef<number | undefined>(undefined);

  const clearTimers = useCallback(() => {
    window.clearTimeout(failsafeRef.current);
    window.clearTimeout(hideDelayRef.current);
  }, []);

  const show = useCallback(() => {
    clearTimers();
    setProgressState(BOOT_PROGRESS.START);
    setPhase("visible");
    failsafeRef.current = window.setTimeout(() => {
      setPhase("hidden");
    }, FAILSAFE_TIMEOUT_MS);
  }, [clearTimers]);

  const setProgress = useCallback((percent: number) => {
    setProgressState(Math.max(0, Math.min(100, percent)));
  }, []);

  const hide = useCallback(
    (opts?: HideOptions) => {
      clearTimers();
      if (opts?.immediate) {
        setPhase("hidden");
        return;
      }
      setProgressState(BOOT_PROGRESS.DONE);
      setPhase("leaving");
      hideDelayRef.current = window.setTimeout(() => {
        setPhase("hidden");
      }, HIDE_DELAY_MS);
    },
    [clearTimers],
  );

  useEffect(() => clearTimers, [clearTimers]);

  const value = useMemo(() => ({ show, hide, setProgress }), [show, hide, setProgress]);

  return (
    <BootOverlayContext.Provider value={value}>
      {children}
      {phase !== "hidden" ? (
        <BootSplash progress={progress} leaving={phase === "leaving"} />
      ) : null}
    </BootOverlayContext.Provider>
  );
}

export function useBootOverlay(): BootOverlayContextValue {
  const ctx = useContext(BootOverlayContext);
  if (!ctx) {
    throw new Error("useBootOverlay must be used within BootOverlayProvider");
  }
  return ctx;
}
