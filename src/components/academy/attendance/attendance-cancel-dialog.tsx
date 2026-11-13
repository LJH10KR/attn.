"use client";

import { useEffect, useState } from "react";
import { ModalPortal } from "@/components/ui/modal-portal";
import {
  ARRIVAL_CANCEL_REASON_LOCKED_MESSAGE,
  arrivalCancelBlock,
  CLASS_STATUS_LABELS,
  type AttendanceStatus,
} from "@/lib/academy/attendance-rules";

/** 화면이 아는 그날 반 출결(구독 중인 반만) */
export type KnownClassRecord = { className: string; status: AttendanceStatus };

/**
 * 취소 확인 창 대상(2-J). 3-A: `past`면 지난 날짜 정정(지우기) — 학부모 알림 없음·정정 기록이 남음,
 * 질병·학원 사정 미등원도 지울 수 있음(원장·출결 권한만 쓰는 화면).
 */
export type AttendanceCancelTarget = (
  | {
      kind: "class";
      studentId: string;
      studentName: string;
      classId: string;
      className: string;
      status: AttendanceStatus;
    }
  | {
      kind: "arrival";
      studentId: string;
      studentName: string;
      status: AttendanceStatus;
      reason: string | null;
      billed: boolean;
      /** 화면이 구독 중인 그 학생의 반 출결 — 구독하지 않는 반은 서버가 거부 문구로 안내 */
      knownClassRecords: readonly KnownClassRecord[];
    }
) & { past?: boolean };

type DialogText = { title: string; body: string; confirmLabel: string | null };

const NOTIFY_LINE = "학부모에게 취소 알림이 갑니다.";
const PAST_LINE = "학부모 알림은 가지 않고, 정정 기록이 남습니다.";

function withSubject(name: string): string {
  return name ? `${name} 학생의` : "이 학생의";
}

/** 확인 창 문구 — `confirmLabel`이 null이면 취소할 수 없는 경우(닫기만) */
export function attendanceCancelDialogText(t: AttendanceCancelTarget): DialogText {
  const past = t.past === true;
  const verb = past ? "지울" : "취소할";
  if (t.kind === "class") {
    const what = CLASS_STATUS_LABELS[t.status];
    return {
      title: `${withSubject(t.studentName)} ${t.className} ${what} 기록을 ${verb}까요?`,
      body: `${past ? PAST_LINE : NOTIFY_LINE} ${past ? "지우면" : "취소하면"} 미처리로 돌아갑니다.`,
      confirmLabel: `${what} 기록 ${past ? "지우기" : "취소"}`,
    };
  }
  const what = t.status === "present" ? "등원" : "미등원";
  const rawBlock = arrivalCancelBlock({
    status: t.status,
    reason: t.reason,
    billed: t.billed,
    classRecordCount: t.knownClassRecords.length,
  });
  // 지난 날짜 정정은 질병·학원 사정 미등원도 지울 수 있다(출결 권한만 쓰는 화면)
  const block = past && rawBlock === "reason_locked" ? null : rawBlock;
  if (block === "has_class_records") {
    const list = t.knownClassRecords.map((r) => `${r.className} ${CLASS_STATUS_LABELS[r.status]}`).join(", ");
    return {
      title: `${what} 기록을 ${past ? "지울" : "취소할"} 수 없습니다`,
      body: past
        ? `그날 ${list} 기록이 있습니다. 수업 출결을 먼저 정정해 주세요.`
        : `오늘 ${list} 기록이 있습니다. 출석·결석을 먼저 취소해 주세요.`,
      confirmLabel: null,
    };
  }
  if (block === "billed") {
    return {
      title: `${what} 기록을 ${past ? "지울" : "취소할"} 수 없습니다`,
      body: "청구서 결석 차감에 반영된 날입니다. 청구서에서 차감을 삭제한 뒤 정정해 주세요.",
      confirmLabel: null,
    };
  }
  if (block === "reason_locked") {
    return { title: `${what} 기록을 취소할 수 없습니다`, body: ARRIVAL_CANCEL_REASON_LOCKED_MESSAGE, confirmLabel: null };
  }
  if (past) {
    return {
      title: `${withSubject(t.studentName)} ${what} 기록을 지울까요?`,
      body: `${PAST_LINE} 지우면 그날 "기록 없음"이 됩니다.`,
      confirmLabel: `${what} 기록 지우기`,
    };
  }
  return {
    title: `${withSubject(t.studentName)} ${what} 기록을 취소할까요?`,
    body:
      t.status === "present"
        ? `${NOTIFY_LINE} 취소하면 등원 전으로 돌아가, 수업 출석·결석은 다시 등원 처리한 뒤 기록할 수 있습니다.`
        : NOTIFY_LINE,
    confirmLabel: `${what} 기록 취소`,
  };
}

/**
 * 출결 취소 확인 창(2-J) — 반 상세 시트·선생님 화면·학생 상세 시트 공용(아래쪽 시트).
 * `onConfirmAction`은 성공하면 null, 실패하면 창 안에 보여 줄 문구를 돌려준다. 처리 중에는 닫히지 않는다.
 */
export function AttendanceCancelDialog({
  target,
  onConfirmAction,
  onCloseAction,
}: {
  target: AttendanceCancelTarget;
  onConfirmAction: () => Promise<string | null>;
  onCloseAction: () => void;
}) {
  const text = attendanceCancelDialogText(target);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onCloseAction();
      }
    };
    // 캡처 단계 — 아래 시트의 Escape(시트 닫기)보다 먼저 받는다
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onCloseAction]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const message = await onConfirmAction();
    if (message === null) {
      onCloseAction();
      return;
    }
    setError(message);
    setBusy(false);
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[260] flex items-end justify-center bg-black/40 sm:items-center"
        role="presentation"
        onClick={() => (busy ? undefined : onCloseAction())}
      >
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="attendance-cancel-title"
          className="w-full max-w-lg rounded-t-3xl bg-white p-5 pb-[calc(max(1.25rem,env(safe-area-inset-bottom))+30px)] shadow-2xl sm:rounded-3xl sm:pb-5"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 id="attendance-cancel-title" className="break-keep text-base font-semibold text-foreground">
            {text.title}
          </h2>
          <p className="mt-2 break-keep text-sm text-neutral-600">{text.body}</p>
          {error ? (
            <p className="mt-2 break-keep text-sm text-red-700" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onCloseAction}
              className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium disabled:opacity-50"
            >
              닫기
            </button>
            {text.confirmLabel ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void confirm()}
                className="flex-1 rounded-2xl bg-red-600 py-3 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? (target.past ? "지우는 중…" : "취소하는 중…") : text.confirmLabel}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
