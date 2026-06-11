"use client";

import { ModalPortal } from "@/components/ui/modal-portal";

export type ProcessStatusModalProps = {
  open: boolean;
  title: string;
  description?: string;
  /** 로그아웃 등 — 배경·카드 진입 애니메이션 */
  animated?: boolean;
};

export function ProcessStatusModal({
  open,
  title,
  description,
  animated = false,
}: ProcessStatusModalProps) {
  if (!open) return null;

  return (
    <ModalPortal>
      <div
        className={`fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px] ${
          animated ? "attn-process-overlay-in" : ""
        }`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div
          className={`w-full max-w-xs rounded-3xl bg-white px-6 py-7 text-center shadow-xl dark:bg-neutral-900 ${
            animated ? "attn-process-card-in" : ""
          }`}
        >
          <div className="mx-auto mb-4 h-10 w-10 rounded-full border-[3px] border-neutral-200 border-t-[#222] animate-spin dark:border-white/20 dark:border-t-white" />
          <p className="text-base font-semibold text-foreground">{title}</p>
          {description ? (
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              {description}
            </p>
          ) : null}
        </div>
      </div>
    </ModalPortal>
  );
}
