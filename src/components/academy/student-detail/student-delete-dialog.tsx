"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useEffect, useRef, useState } from "react";
import { ModalPortal } from "@/components/ui/modal-portal";
import type { StudentVM } from "@/lib/academy/student-row";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

/** 원생 삭제 확인 — `deleteAcademyStudent`(권한 `operations.students`, 하위 기록·메모까지 삭제) */
export function StudentDeleteDialog({
  academyId,
  student,
  onCancelAction,
  onDeletedAction,
}: {
  academyId: string;
  student: StudentVM;
  onCancelAction: () => void;
  onDeletedAction: (message: string) => void;
}) {
  useBodyScrollLock(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancelAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancelAction]);

  const onConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await httpsCallable(getFirebaseFunctions(), "deleteAcademyStudent")({ academyId, studentId: student.id });
      onDeletedAction(`${student.name} 원생을 삭제했습니다.`);
    } catch (e) {
      setError(e instanceof FirebaseError && e.message ? e.message : "삭제하지 못했습니다.");
      setBusy(false);
    }
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[210] flex items-end justify-center bg-black/45 p-4 sm:items-center"
        role="presentation"
        onClick={() => {
          if (!busy) onCancelAction();
        }}
      >
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="student-delete-title"
          className="w-full max-w-md rounded-3xl bg-background p-6 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 id="student-delete-title" className="text-base font-semibold text-foreground">
            원생을 삭제할까요?
          </h2>
          <p className="mt-3 break-keep text-sm text-neutral-700">
            <span className="font-medium">{student.name}</span>
            {student.gradeLabel ? <span className="text-neutral-500"> ({student.gradeLabel})</span> : null}의 정보와
            출결·청구·수업 기록, 메모가 모두 삭제됩니다. 되돌릴 수 없습니다.
          </p>
          {student.parentUids.length > 0 ? (
            <p className="mt-2 break-keep rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
              앱에 연결된 보호자 {student.parentUids.length}명은 더 이상 이 원생을 볼 수 없습니다. 퇴원 처리만
              하려면 삭제 대신 상태를 &lsquo;퇴원&rsquo;으로 바꿔 주세요.
            </p>
          ) : null}
          {error ? (
            <p className="mt-3 text-sm text-red-700" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <button
              ref={cancelRef}
              type="button"
              disabled={busy}
              className="rounded-2xl border border-neutral-300/80 bg-white/80 px-4 py-2.5 text-sm font-medium text-neutral-800 disabled:opacity-50"
              onClick={onCancelAction}
            >
              취소
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-2xl bg-red-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
              onClick={() => void onConfirm()}
            >
              {busy ? "삭제 중…" : "삭제"}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
