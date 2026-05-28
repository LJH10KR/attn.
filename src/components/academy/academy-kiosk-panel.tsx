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
  /** 키오스크 표시용 010-****-1234 */
  phoneMasked: string | null;
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
  const nq = normalizeQuery(q);
  if (!nq) return false;
  if (normalizeQuery(row.name).includes(nq)) return true;
  if (row.parentName && normalizeQuery(row.parentName).includes(nq)) return true;
  const phoneQ = nq.replace(/\D/g, "");
  // 숫자 없는 검색어는 ""가 되어 전화 끝 4자리에 모두 매칭되는 버그 방지
  if (phoneQ.length > 0 && row.phoneLast4?.includes(phoneQ)) return true;
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

  const trimmedQuery = query.trim();
  const showResults = trimmedQuery.length > 0;

  const filtered = useMemo(
    () =>
      showResults
        ? rows.filter((r) => matchesRow(r, trimmedQuery)).slice(0, 40)
        : [],
    [rows, trimmedQuery, showResults],
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
        <div className="overflow-hidden rounded-full border border-white/65 bg-white/38 p-[2px] shadow-[0_12px_30px_-14px_rgba(0,0,0,0.10),0_-12px_30px_-14px_rgba(0,0,0,0.10),12px_0_30px_-14px_rgba(0,0,0,0.10),-12px_0_30px_-14px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.8)] backdrop-blur-xl dark:border-white/20 dark:bg-white/12 dark:shadow-[0_14px_34px_-16px_rgba(0,0,0,0.36),0_-14px_34px_-16px_rgba(0,0,0,0.36),14px_0_34px_-16px_rgba(0,0,0,0.36),-14px_0_34px_-16px_rgba(0,0,0,0.36),inset_0_1px_0_rgba(255,255,255,0.2)]">
          <div className="flex items-center gap-2 rounded-full bg-white/68 px-3.5 py-2.5 dark:bg-neutral-900/72">
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className="h-5 w-5 shrink-0 text-neutral-500 dark:text-neutral-400"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              id="kiosk-search"
              type="text"
              autoComplete="off"
              placeholder="이름 · 전화 끝 4자리 · 학부모 이름"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none ring-0 placeholder:text-neutral-400"
            />
            {query.length > 0 ? (
              <button
                type="button"
                aria-label="검색어 지우기"
                onClick={() => setQuery("")}
                className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-neutral-300/55 bg-white/55 text-neutral-700 shadow-[0_4px_14px_-4px_rgba(0,0,0,0.12)] backdrop-blur-md transition hover:bg-white/85 active:scale-[0.98] dark:border-white/12 dark:bg-white/10 dark:text-neutral-200 dark:hover:bg-white/15"
              >
                <span className="pointer-events-none absolute inset-[1px] rounded-full bg-gradient-to-br from-white/70 via-white/20 to-transparent dark:from-white/20 dark:via-white/5 dark:to-transparent" />
                <svg
                  aria-hidden
                  viewBox="0 0 24 24"
                  className="relative z-[1] h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {toast ? (
        <p className="mb-3 rounded-xl bg-neutral-100 px-3 py-2 text-center text-sm text-neutral-800 dark:bg-white/10 dark:text-neutral-200">
          {toast}
        </p>
      ) : null}

      {showResults ? (
        <ul className="flex flex-1 flex-col gap-2 pb-8">
          {filtered.length === 0 ? (
            <li className="py-16 text-center text-sm text-neutral-500">검색 결과가 없습니다.</li>
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
                    {row.phoneMasked ?? "연락처 없음"}
                    {row.parentName ? ` · ${row.parentName}` : ""}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}

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
        phaseKey={pinStudent?.studentId ?? "closed"}
        title="출석 PIN"
        description={
          pinStudent
            ? `${pinStudent.name} 학생 — 학부모가 설정한 PIN 4자리를 입력해 주세요.`
            : undefined
        }
        error={pinError}
        busy={busy}
        busyTitle="출석 처리 중..."
        busyDescription="잠시만 기다려 주세요."
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
