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

type BootOverlayContextValue = {
  show: () => void;
  hide: () => void;
};

const BootOverlayContext = createContext<BootOverlayContextValue | null>(null);

/** 어떤 경로도 오버레이를 못 끄는 예외 상황을 대비한 안전장치 */
const FAILSAFE_TIMEOUT_MS = 8000;

function BootSplash() {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background transition-opacity duration-300"
      role="status"
      aria-live="polite"
      aria-label="불러오는 중"
    >
      <h1 className="attn-boot-pulse text-4xl font-semibold tracking-tight text-foreground">
        attn.
      </h1>
    </div>
  );
}

export function BootOverlayProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);

  const show = useCallback(() => {
    setVisible(true);
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      setVisible(false);
    }, FAILSAFE_TIMEOUT_MS);
  }, []);

  const hide = useCallback(() => {
    window.clearTimeout(timeoutRef.current);
    setVisible(false);
  }, []);

  useEffect(() => {
    return () => window.clearTimeout(timeoutRef.current);
  }, []);

  const value = useMemo(() => ({ show, hide }), [show, hide]);

  return (
    <BootOverlayContext.Provider value={value}>
      {children}
      {visible ? <BootSplash /> : null}
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
