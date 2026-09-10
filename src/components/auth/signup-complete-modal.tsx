"use client";

import { ModalPortal } from "@/components/ui/modal-portal";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

export function SignupCompleteModal({
  open,
  title,
  description,
  onConfirmAction,
}: {
  open: boolean;
  title: string;
  description: string;
  onConfirmAction: () => void;
}) {
  useBodyScrollLock(open);
  if (!open) return null;

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="w-full max-w-sm rounded-3xl bg-white px-6 py-7 text-center shadow-xl dark:bg-neutral-900">
          <p className="text-base font-semibold text-foreground">{title}</p>
          <p className="mt-3 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
            {description}
          </p>
          <button
            type="button"
            onClick={onConfirmAction}
            className="mt-6 w-full rounded-2xl bg-[#222] py-3 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950"
          >
            확인
          </button>
        </div>
      </div>
    </ModalPortal>
  );
}
