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
  /** 실제 진행률과 무관 — 시작하자마자 살짝 차올라 "지금 진행 중"임을 보여주는 최소 피드백 */
  IDLE_HINT: 5,
  AUTH_RESTORED: 35,
  ROLE_RESOLVED: 70,
  DONE: 100,
} as const;

type OverlayPhase = "hidden" | "visible" | "splashing" | "leaving";

/** 어떤 경로도 오버레이를 못 끄는 예외 상황을 대비한 안전장치 */
const FAILSAFE_TIMEOUT_MS = 8000;
/** globals.css의 .attn-boot-wordmark-fill transition 시간과 맞춤 — 물이 끝까지 차오르는 시간 */
const FILL_TRANSITION_MS = 1200;
/** 물이 다 찬 뒤 튀어 오르는 연출(드롭릿)이 끝날 때까지 여유 */
const SPLASH_TAIL_MS = 550;
/** 페이드아웃 시간 */
const FADE_MS = 300;

function BootSplash({
  progress,
  splashing,
  leaving,
}: {
  progress: number;
  splashing: boolean;
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
        {splashing ? (
          <span className="attn-boot-splash" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function BootOverlayProvider({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<OverlayPhase>("hidden");
  const [progress, setProgressState] = useState<number>(BOOT_PROGRESS.START);
  const failsafeRef = useRef<number | undefined>(undefined);
  const hideDelayRef = useRef<number | undefined>(undefined);
  const idleHintFrameRef = useRef<number | undefined>(undefined);

  const clearTimers = useCallback(() => {
    window.clearTimeout(failsafeRef.current);
    window.clearTimeout(hideDelayRef.current);
    if (idleHintFrameRef.current !== undefined) {
      window.cancelAnimationFrame(idleHintFrameRef.current);
      idleHintFrameRef.current = undefined;
    }
  }, []);

  const show = useCallback(() => {
    clearTimers();
    setProgressState(BOOT_PROGRESS.START);
    setPhase("visible");
    // 마운트 직후 한 프레임 뒤에 살짝 채워서, 0%에서도 "지금 시작됐다"는 게 눈에 보이도록 함
    idleHintFrameRef.current = window.requestAnimationFrame(() => {
      setProgressState(BOOT_PROGRESS.IDLE_HINT);
    });
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
      setPhase("splashing");
      hideDelayRef.current = window.setTimeout(() => {
        setPhase("leaving");
        hideDelayRef.current = window.setTimeout(() => {
          setPhase("hidden");
        }, FADE_MS);
      }, FILL_TRANSITION_MS + SPLASH_TAIL_MS);
    },
    [clearTimers],
  );

  useEffect(() => clearTimers, [clearTimers]);

  const value = useMemo(() => ({ show, hide, setProgress }), [show, hide, setProgress]);

  return (
    <BootOverlayContext.Provider value={value}>
      {children}
      {phase !== "hidden" ? (
        <BootSplash
          progress={progress}
          splashing={phase === "splashing"}
          leaving={phase === "leaving"}
        />
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
