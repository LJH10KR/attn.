"use client";

import { doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useEffect, useState } from "react";
import { ModalPortal } from "@/components/ui/modal-portal";
import { attendanceActionErrorMessage } from "@/lib/academy/attendance-records";
import {
  ATTENDANCE_NOTIFY_TYPES,
  ATTENDANCE_NOTIFY_TYPE_LABELS,
  readNotifySettings,
  type AttendanceNotifyType,
} from "@/lib/academy/attendance-rules";
import { academyAttendanceSettingsPath } from "@/lib/firebase/attn-schema";
import { getFirebaseDb, getFirebaseFunctions } from "@/lib/firebase/client-app";

type Notify = Record<AttendanceNotifyType, boolean>;

const HINTS: Partial<Record<AttendanceNotifyType, string>> = {
  arrival: "키오스크 등원 포함",
  arrivalAbsent: "기간 결석 요약 포함",
  correction: "모든 기록 취소 알림",
};

/** 3-B 출결 설정(⚙, B6·★8) 실시간 읽기 — 문서가 없으면 모두 켬. undefined = 읽는 중 */
export function useAttendanceNotifySettings(academyId: string, enabled: boolean): {
  notify: Notify | undefined;
  error: boolean;
} {
  const [state, setState] = useState<{ key: string | null; notify: Notify | undefined; error: boolean }>({
    key: null,
    notify: undefined,
    error: false,
  });
  const key = enabled ? academyId : null;
  useEffect(() => {
    if (!key) return;
    return onSnapshot(
      doc(getFirebaseDb(), academyAttendanceSettingsPath(key)),
      (snap) => setState({ key, notify: readNotifySettings(snap.get("notify")), error: false }),
      () => setState({ key, notify: undefined, error: true }),
    );
  }, [key]);
  if (!key || state.key !== key) return { notify: undefined, error: false };
  return { notify: state.notify, error: state.error };
}

/**
 * 3-B ⚙ 출결 설정 시트 — 학부모 알림 7종 켜기·끄기(학원 단위). 원장·출결 권한만 저장(서버).
 * 끈 종류는 학부모에게 가지 않고 알림 기록에 "알림 꺼짐"으로만 남는다(★9). 저장은 늘 7종 전체(서버 조건).
 */
export function AttendanceSettingsSheet({
  academyId,
  onSavedAction,
  onCloseAction,
}: {
  academyId: string;
  onSavedAction: (message: string) => void;
  onCloseAction: () => void;
}) {
  const live = useAttendanceNotifySettings(academyId, true);
  const [draft, setDraft] = useState<Notify | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = draft ?? live.notify;
  const dirty = Boolean(draft && live.notify && ATTENDANCE_NOTIFY_TYPES.some((t) => draft[t] !== live.notify![t]));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onCloseAction();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onCloseAction]);

  const toggle = (t: AttendanceNotifyType) => {
    if (!current) return;
    setDraft({ ...current, [t]: !current[t] });
    setError(null);
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await httpsCallable(getFirebaseFunctions(), "updateAttendanceSettings")({ academyId, notify: draft });
      const off = ATTENDANCE_NOTIFY_TYPES.filter((t) => !draft[t]).map((t) => ATTENDANCE_NOTIFY_TYPE_LABELS[t]);
      onSavedAction(off.length ? `출결 설정을 저장했습니다. 꺼 둔 알림: ${off.join(", ")}` : "출결 설정을 저장했습니다. 모든 알림이 켜져 있습니다.");
      onCloseAction();
    } catch (e) {
      setError(attendanceActionErrorMessage(e, "저장하지 못했습니다. 잠시 후 다시 시도해 주세요."));
      setBusy(false);
    }
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[220] flex items-end justify-center bg-black/40 sm:items-center"
        role="presentation"
        onClick={() => (busy ? undefined : onCloseAction())}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="attendance-settings-title"
          className="flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-3xl bg-[#f7f6f2] shadow-2xl sm:rounded-3xl"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="flex shrink-0 items-start justify-between gap-2 px-5 pb-2 pt-4">
            <div>
              <h2 id="attendance-settings-title" className="text-base font-semibold text-foreground">
                출결 설정
              </h2>
              <p className="mt-0.5 break-keep text-xs text-neutral-500">학부모 알림 종류를 켜고 끕니다(학원 전체).</p>
            </div>
            <button
              type="button"
              onClick={onCloseAction}
              disabled={busy}
              className="rounded-full px-2 py-1 text-sm text-neutral-500 disabled:opacity-40"
              aria-label="닫기"
            >
              ✕
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-[calc(max(1.25rem,env(safe-area-inset-bottom))+12px)]">
            {live.error ? (
              <p className="rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-800">설정을 불러오지 못했습니다. 다시 열어 주세요.</p>
            ) : !current ? (
              <p className="py-8 text-center text-sm text-neutral-400">불러오는 중…</p>
            ) : (
              <ul className="divide-y divide-neutral-200/70 rounded-2xl border border-neutral-200/80 bg-white/70">
                {ATTENDANCE_NOTIFY_TYPES.map((t) => (
                  <li key={t}>
                    <label className="flex cursor-pointer items-center justify-between gap-3 px-3 py-3">
                      <span className="min-w-0">
                        <span className="block text-sm text-foreground">{ATTENDANCE_NOTIFY_TYPE_LABELS[t]} 알림</span>
                        {HINTS[t] ? <span className="block text-[10px] text-neutral-500">{HINTS[t]}</span> : null}
                      </span>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={current[t]}
                        disabled={busy}
                        onChange={() => toggle(t)}
                        className="h-5 w-9 shrink-0 accent-emerald-600"
                        aria-label={`${ATTENDANCE_NOTIFY_TYPE_LABELS[t]} 알림`}
                      />
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 break-keep text-[11px] text-neutral-500">
              끈 알림은 학부모에게 가지 않고, 알림 기록에 &quot;알림 꺼짐&quot;으로만 남습니다. 출결 기록은 그대로 저장됩니다.
            </p>
            {error ? (
              <p className="mt-2 break-keep text-xs text-red-700" role="alert">
                {error}
              </p>
            ) : null}
            <button
              type="button"
              disabled={!dirty || busy}
              onClick={() => void save()}
              className="mt-4 w-full rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy ? "저장하는 중…" : "저장"}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
