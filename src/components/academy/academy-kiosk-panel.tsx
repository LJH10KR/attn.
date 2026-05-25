"use client";

import { httpsCallable } from "firebase/functions";
import { useCallback, useMemo, useState } from "react";
import { PinPadModal } from "@/components/academy/pin-pad-modal";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { FirebaseError } from "firebase/app";

export type KioskStudentRow = {
  studentId: string;
  name: string;
  phoneLast4: string | null;
  parentName: string;
};

type Props = {
  academyId: string;
  requireStudentCheckInPin: boolean;
  rows: KioskStudentRow[];
  onCheckInDoneAction?: () => void;
};

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, "");
}

function matchesRow(row: KioskStudentRow, q: string): boolean {
  if (!q) return true;
  const nq = normalizeQuery(q);
  if (normalizeQuery(row.name).includes(nq)) return true;
  if (row.parentName && normalizeQuery(row.parentName).includes(nq)) return true;
  if (row.phoneLast4 && row.phoneLast4.includes(nq.replace(/\D/g, ""))) return true;
  return false;
}

function callableMessage(err: unknown, fallback: string): string {
  if (err instanceof FirebaseError && err.message) return err.message;
  return fallback;
}

export function AcademyKioskPanel({
  academyId,
  requireStudentCheckInPin,
  rows,
  onCheckInDoneAction,
}: Props) {
  const [query, setQuery] = useState("");
  const [confirmStudent, setConfirmStudent] = useState<KioskStudentRow | null>(null);
  const [pinStudent, setPinStudent] = useState<KioskStudentRow | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const filtered = useMemo(
    () => rows.filter((r) => matchesRow(r, query)).slice(0, 40),
    [rows, query],
  );

  const submitCheckIn = useCallback(
    async (student: KioskStudentRow, checkInPin?: string) => {
      setBusy(true);
      setPinError(null);
      try {
        const fn = httpsCallable(getFirebaseFunctions(), "submitKioskCheckIn");
        await fn({
          academyId,
          studentId: student.studentId,
          ...(checkInPin ? { checkInPin } : {}),
        });
        setToast(`${student.name} 학생 출석이 완료되었습니다.`);
        setConfirmStudent(null);
        setPinStudent(null);
        onCheckInDoneAction?.();
      } catch (err) {
        const msg = callableMessage(err, "출석 처리에 실패했습니다.");
        if (pinStudent) {
          setPinError(msg);
        } else {
          setToast(msg);
        }
      } finally {
        setBusy(false);
      }
    },
    [academyId, onCheckInDoneAction, pinStudent],
  );

  const onSelectStudent = (row: KioskStudentRow) => {
    if (requireStudentCheckInPin) {
      setPinStudent(row);
      setPinError(null);
    } else {
      setConfirmStudent(row);
    }
  };

  return (
    <div className="flex min-h-[50dvh] flex-col">
      <div className="sticky top-[calc(max(0.85rem,env(safe-area-inset-top))+3.25rem)] z-20 -mx-4 bg-background/90 px-4 pb-3 pt-2 backdrop-blur-md">
        <label className="sr-only" htmlFor="kiosk-search">
          학생 검색
        </label>
        <input
          id="kiosk-search"
          type="search"
          autoComplete="off"
          placeholder="이름 · 전화 끝 4자리 · 학부모 이름"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-2xl border border-neutral-200/80 bg-white/80 px-4 py-3.5 text-base shadow-sm outline-none ring-0 placeholder:text-neutral-400 focus:border-[#222]/30 dark:border-white/12 dark:bg-white/8 dark:focus:border-white/25"
        />
      </div>

      {toast ? (
        <p className="mb-3 rounded-xl bg-neutral-100 px-3 py-2 text-center text-sm text-neutral-800 dark:bg-white/10 dark:text-neutral-200">
          {toast}
        </p>
      ) : null}

      <ul className="flex flex-1 flex-col gap-2 pb-8">
        {filtered.length === 0 ? (
          <li className="py-16 text-center text-sm text-neutral-500">
            {query.trim() ? "검색 결과가 없습니다." : "학생 목록을 불러오는 중이거나 등록된 학생이 없습니다."}
          </li>
        ) : (
          filtered.map((row) => (
            <li key={row.studentId}>
              <button
                type="button"
                onClick={() => onSelectStudent(row)}
                className="glass-tile glass-tile-hover flex w-full flex-col items-start gap-0.5 rounded-2xl px-4 py-3.5 text-left"
              >
                <span className="text-base font-semibold text-foreground">{row.name}</span>
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  {row.phoneLast4 ? `전화 ···${row.phoneLast4}` : "연락처 없음"}
                  {row.parentName ? ` · ${row.parentName}` : ""}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>

      {confirmStudent ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-xl dark:bg-neutral-900">
            <p className="text-lg font-semibold text-foreground">출석 확인</p>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              <span className="font-medium text-foreground">{confirmStudent.name}</span> 학생을
              출석 처리할까요?
            </p>
            <div className="mt-6 flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmStudent(null)}
                className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium dark:border-white/15"
              >
                취소
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void submitCheckIn(confirmStudent)}
                className="flex-1 rounded-2xl bg-[#222] py-3 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950"
              >
                출석
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <PinPadModal
        open={Boolean(pinStudent)}
        title="출석 PIN"
        description={
          pinStudent
            ? `${pinStudent.name} 학생 — 학부모가 설정한 PIN 4자리를 입력해 주세요.`
            : undefined
        }
        error={pinError}
        busy={busy}
        onCloseAction={() => {
          if (!busy) {
            setPinStudent(null);
            setPinError(null);
          }
        }}
        onCompleteAction={(pin) => {
          if (pinStudent) void submitCheckIn(pinStudent, pin);
        }}
      />
    </div>
  );
}
