"use client";

import type { ReactNode } from "react";

export function KioskKeypadShell({ children }: { children: ReactNode }) {
  return (
    <div
      className="border-t border-white/50 bg-white/72 px-3 pt-3 shadow-[0_-8px_32px_-8px_rgba(0,0,0,0.12)] backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/88 dark:shadow-[0_-8px_32px_-8px_rgba(0,0,0,0.45)]"
      style={{
        paddingBottom: "calc(36px + env(safe-area-inset-bottom, 0px))",
      }}
    >
      {children}
    </div>
  );
}

export function KioskKeypadButton({
  children,
  onClickAction,
  className = "",
  wide = false,
  ariaLabel,
}: {
  children: ReactNode;
  onClickAction: () => void;
  className?: string;
  wide?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClickAction}
      className={`flex h-11 items-center justify-center rounded-xl bg-neutral-100 text-base font-medium text-foreground transition active:scale-[0.98] hover:bg-neutral-200 dark:bg-white/10 dark:hover:bg-white/15 ${wide ? "col-span-3" : ""} ${className}`}
    >
      {children}
    </button>
  );
}
