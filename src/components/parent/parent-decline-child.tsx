"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useEffect, useState } from "react";
import { ModalPortal } from "@/components/ui/modal-portal";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";

export const DECLINE_DONE_MESSAGE = "연결을 해제하고 학원에 알렸어요.";

/**
 * 학부모 자녀 카드 "내 자녀가 아니에요"(2-L, L1-3) — 확인 시트 → 그 자녀와의 연결만 해제(`declineParentChildLink`) + 원장 벨.
 * 학원 보호자 번호 오타로 잘못 연결된 경우용. 학부모가 자기 접근만 줄이므로 원장 확인 없이 바로 처리된다.
 */
export function ParentDeclineChildButton({
  studentId,
  studentName,
  onDeclinedAction,
}: {
  studentId: string;
  studentName: string;
  onDeclinedAction: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await httpsCallable(getFirebaseFunctions(), "declineParentChildLink")({ studentId });
      setOpen(false);
      onDeclinedAction(DECLINE_DONE_MESSAGE);
    } catch (e) {
      setError(e instanceof FirebaseError && e.message ? e.message : "연결을 해제하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  const who = studentName ? `${studentName} 학생이` : "이 학생이";

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className="mt-2 text-[11px] text-neutral-500 underline underline-offset-2"
        data-decline-child={studentId}
      >
        내 자녀가 아니에요
      </button>
      {open ? (
        <ModalPortal>
          <div
            className="fixed inset-0 z-[260] flex items-end justify-center bg-black/40 sm:items-center"
            role="presentation"
            onClick={() => (busy ? undefined : setOpen(false))}
          >
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="decline-child-title"
              className="w-full max-w-lg rounded-t-3xl bg-white p-5 pb-[calc(max(1.25rem,env(safe-area-inset-bottom))+30px)] shadow-2xl sm:rounded-3xl sm:pb-5"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 id="decline-child-title" className="break-keep text-base font-semibold text-foreground">
                {who} 내 자녀가 아닌가요?
              </h2>
              <p className="mt-2 break-keep text-sm text-neutral-600">
                연결을 해제하면 이 학생 정보를 더 볼 수 없고, 학원에 알림이 갑니다.
              </p>
              {error ? (
                <p className="mt-2 break-keep text-sm text-red-700" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setOpen(false)}
                  className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium disabled:opacity-50"
                >
                  닫기
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void confirm()}
                  className="flex-1 rounded-2xl bg-red-600 py-3 text-sm font-medium text-white disabled:opacity-50"
                >
                  {busy ? "해제하는 중…" : "연결 해제"}
                </button>
              </div>
            </div>
          </div>
        </ModalPortal>
      ) : null}
    </>
  );
}
