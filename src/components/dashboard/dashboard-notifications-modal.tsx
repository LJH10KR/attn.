"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const glassCard = "glass-card";

export type DashboardNotificationRow = {
  id: string;
  title: string;
  detail?: string;
};

type DashboardNotificationsModalProps = {
  open: boolean;
  onClose: () => void;
  heading: string;
  items: DashboardNotificationRow[];
  emptyLabel: string;
  /** 둘 다 주면 스와이프 삭제·전체 삭제 UI 표시 */
  onDeleteItem?: (id: string) => void | Promise<void>;
  onDeleteAll?: () => void | Promise<void>;
};

const DELETE_PANEL_PX = 72;

function SwipeToDeleteNotificationRow({
  title,
  detail,
  isOpen,
  onOpenChange,
  onDelete,
}: {
  title: string;
  detail?: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: () => void;
}) {
  const outerRef = useRef<HTMLLIElement>(null);
  const [outerW, setOuterW] = useState(0);
  const startXRef = useRef(0);
  const startWasOpenRef = useRef(false);
  const [dragDelta, setDragDelta] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setOuterW(el.clientWidth);
    });
    ro.observe(el);
    setOuterW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const panningRef = useRef(false);

  const slidePx =
    dragDelta === null
      ? isOpen
        ? DELETE_PANEL_PX
        : 0
      : startWasOpenRef.current
        ? Math.min(DELETE_PANEL_PX, Math.max(0, DELETE_PANEL_PX - dragDelta))
        : Math.min(DELETE_PANEL_PX, Math.max(0, -dragDelta));

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    panningRef.current = true;
    startXRef.current = e.clientX;
    startWasOpenRef.current = isOpen;
    setDragDelta(0);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!panningRef.current) return;
    setDragDelta(e.clientX - startXRef.current);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!panningRef.current) return;
    panningRef.current = false;
    const delta = e.clientX - startXRef.current;
    const wasOpen = startWasOpenRef.current;
    const endSlide = wasOpen
      ? Math.min(DELETE_PANEL_PX, Math.max(0, DELETE_PANEL_PX - delta))
      : Math.min(DELETE_PANEL_PX, Math.max(0, -delta));
    onOpenChange(endSlide >= DELETE_PANEL_PX / 2);
    setDragDelta(null);
  };

  const onPointerCancel = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    panningRef.current = false;
    setDragDelta(null);
  };

  const innerW = outerW > 0 ? outerW + DELETE_PANEL_PX : undefined;
  const dragging = dragDelta !== null;

  return (
    <li ref={outerRef} className="relative w-full overflow-hidden rounded-2xl">
      <div
        className="flex touch-pan-y"
        style={{
          width: innerW ?? "100%",
          transform: outerW > 0 ? `translateX(-${slidePx}px)` : undefined,
          transition: dragging ? "none" : "transform 200ms ease-out",
        }}
      >
        <div
          role="presentation"
          className={`min-w-0 shrink-0 cursor-grab active:cursor-grabbing px-4 py-3 ${glassCard}`}
          style={{ width: outerW > 0 ? outerW : "100%" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          <p className="pointer-events-none text-sm font-medium text-foreground">{title}</p>
          {detail ? (
            <p className="pointer-events-none mt-1 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
              {detail}
            </p>
          ) : null}
        </div>
        <div
          className="flex shrink-0 items-stretch"
          style={{ width: DELETE_PANEL_PX }}
        >
          <button
            type="button"
            className="flex w-full items-center justify-center bg-red-600 text-xs font-semibold text-white transition hover:bg-red-700"
            onClick={() => {
              onOpenChange(false);
              onDelete();
            }}
          >
            삭제
          </button>
        </div>
      </div>
    </li>
  );
}

export function DashboardNotificationsModal({
  open,
  onClose,
  heading,
  items,
  emptyLabel,
  onDeleteItem,
  onDeleteAll,
}: DashboardNotificationsModalProps) {
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);
  const [openSwipeId, setOpenSwipeId] = useState<string | null>(null);
  const deleteEnabled = Boolean(onDeleteItem && onDeleteAll);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmAllOpen) setConfirmAllOpen(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, confirmAllOpen]);

  useEffect(() => {
    if (!open) {
      setConfirmAllOpen(false);
      setOpenSwipeId(null);
    }
  }, [open]);

  const handleOpenSwipe = useCallback((id: string, nextOpen: boolean) => {
    if (nextOpen) setOpenSwipeId(id);
    else setOpenSwipeId((cur) => (cur === id ? null : cur));
  }, []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[50] flex items-center justify-center bg-black/35 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dashboard-notifications-modal-title"
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="닫기"
        onClick={onClose}
      />
      <div
        className={`relative z-[51] w-full max-w-md max-h-[min(28rem,calc(100dvh-2rem))] min-h-0 overflow-hidden rounded-[1.75rem] border border-white/60 bg-[rgba(252,251,248,0.98)] shadow-[0_24px_80px_-20px_rgba(0,0,0,0.22)] backdrop-blur-xl dark:border-white/12 dark:bg-neutral-900/95`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-neutral-200/70 px-4 py-4 dark:border-white/10 sm:px-5">
          <h2
            id="dashboard-notifications-modal-title"
            className="min-w-0 text-base font-semibold text-foreground"
          >
            {heading}
          </h2>
          <div className="flex shrink-0 items-center gap-1.5">
            {deleteEnabled && items.length > 0 ? (
              <button
                type="button"
                onClick={() => setConfirmAllOpen(true)}
                className="rounded-full px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/15"
              >
                전체 삭제
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-black/[0.06] dark:text-neutral-300 dark:hover:bg-white/10"
            >
              닫기
            </button>
          </div>
        </div>
        <div className="max-h-[min(22rem,calc(100dvh-8rem))] overflow-y-auto px-3 py-3">
          {items.length === 0 ? (
            <p className="px-2 py-10 text-center text-sm text-neutral-500">{emptyLabel}</p>
          ) : deleteEnabled ? (
            <ul className="space-y-2">
              {items.map((row) => (
                <SwipeToDeleteNotificationRow
                  key={row.id}
                  title={row.title}
                  detail={row.detail}
                  isOpen={openSwipeId === row.id}
                  onOpenChange={(next) => handleOpenSwipe(row.id, next)}
                  onDelete={() => void onDeleteItem?.(row.id)}
                />
              ))}
            </ul>
          ) : (
            <ul className="space-y-2">
              {items.map((row) => (
                <li key={row.id} className={`rounded-2xl px-4 py-3 ${glassCard}`}>
                  <p className="text-sm font-medium text-foreground">{row.title}</p>
                  {row.detail ? (
                    <p className="mt-1 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
                      {row.detail}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {confirmAllOpen && deleteEnabled ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="dashboard-notifications-delete-all-title"
        >
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            aria-label="취소"
            onClick={() => setConfirmAllOpen(false)}
          />
          <div
            className="relative z-[61] w-full max-w-sm rounded-[1.5rem] border border-white/60 bg-[rgba(252,251,248,0.99)] p-5 shadow-xl dark:border-white/12 dark:bg-neutral-900/96"
            onClick={(e) => e.stopPropagation()}
          >
            <p
              id="dashboard-notifications-delete-all-title"
              className="text-sm font-medium text-foreground"
            >
              전체 삭제를 진행하시겠습니까?
            </p>
            <p className="mt-2 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
              목록에 표시된 알림을 모두 삭제합니다.
            </p>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmAllOpen(false)}
                className="flex-1 rounded-2xl border border-neutral-300/70 py-2.5 text-sm font-medium text-foreground dark:border-white/20"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    try {
                      await onDeleteAll?.();
                    } finally {
                      setConfirmAllOpen(false);
                    }
                  })();
                }}
                className="flex-1 rounded-2xl bg-red-600 py-2.5 text-sm font-medium text-white hover:bg-red-700"
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function formatDashboardBellBadge(count: number): string {
  if (count <= 0) return "";
  if (count > 99) return "99+";
  return String(count);
}
