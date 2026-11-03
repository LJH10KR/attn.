"use client";

import { FirebaseError } from "firebase/app";
import {
  PARENT_APP_STATE_BADGE_CLASS,
  PARENT_APP_STATE_LABELS,
  PARENT_PUSH_LABELS,
  type ParentAppState,
  type ParentPushState,
} from "@/lib/academy/parent-directory";

/** 학부모 관리 화면 공용 조각 */

export const sectionClass = "rounded-2xl border border-neutral-200/80 bg-white/40 px-4 py-3";
export const smallBtnClass =
  "rounded-[8px] border border-neutral-300/70 bg-white/70 px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:bg-white disabled:opacity-40";
export const dangerSmallBtnClass =
  "rounded-[8px] border border-red-300/70 bg-white/70 px-2.5 py-1.5 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-40";

export function fmtDate(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "2-digit",
    month: "numeric",
    day: "numeric",
  });
}

export function callableMessage(e: unknown, fallback: string): string {
  if (e instanceof FirebaseError) return e.message || fallback;
  return fallback;
}

/** Callable 오류 코드(`functions/not-found` → `not-found`) */
export function callableCode(e: unknown): string | null {
  return e instanceof FirebaseError ? e.code.replace(/^functions\//, "") : null;
}

export function won(n: number): string {
  return `${n.toLocaleString("ko-KR")}원`;
}

export function AppStateBadge({ state, extra }: { state: ParentAppState | "none"; extra?: string }) {
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${PARENT_APP_STATE_BADGE_CLASS[state]}`}>
      {PARENT_APP_STATE_LABELS[state]}
      {extra ?? ""}
    </span>
  );
}

const PUSH_BADGE_CLASS: Record<ParentPushState, string> = {
  on: "text-emerald-800",
  off: "text-neutral-500",
  check: "text-amber-800",
};

export function PushBadge({ state }: { state: ParentPushState }) {
  return (
    <span className={`shrink-0 text-[10px] font-medium ${PUSH_BADGE_CLASS[state]}`}>
      {state === "on" ? "🔔" : state === "off" ? "🔕" : "⚠"} {PARENT_PUSH_LABELS[state]}
    </span>
  );
}

/** 하단 확인 창(삭제·비활성화·연결 해제 등) */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger = false,
  busy,
  error,
  onCancelAction,
  onConfirmAction,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  error: string | null;
  onCancelAction: () => void;
  onConfirmAction: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[190] flex items-end justify-center bg-black/40 sm:items-center"
      role="presentation"
      onClick={() => (busy ? undefined : onCancelAction())}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="parent-confirm-title"
        className="w-full max-w-lg rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="parent-confirm-title" className="text-base font-semibold text-foreground">
          {title}
        </h2>
        <p className="mt-2 break-keep text-sm text-neutral-600">{body}</p>
        {error ? (
          <p className="mt-2 break-keep text-sm text-red-700" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancelAction}
            className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium disabled:opacity-50"
          >
            취소
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirmAction}
            className={`flex-1 rounded-2xl py-3 text-sm font-medium text-white disabled:opacity-50 ${
              danger ? "bg-red-600" : "bg-[#222]"
            }`}
          >
            {busy ? "처리 중…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
