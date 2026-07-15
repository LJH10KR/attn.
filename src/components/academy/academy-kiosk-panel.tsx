"use client";

import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KioskHangulKeyboard } from "@/components/academy/kiosk-hangul-keyboard";
import { KioskNumericKeypad } from "@/components/academy/kiosk-numeric-keypad";
import { PinPadModal } from "@/components/academy/pin-pad-modal";
import { appendHangulJamo, backspaceHangul } from "@/lib/hangul/kiosk-hangul-input";
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

type SearchMode = "phone" | "name";

type Props = {
  academyId: string;
  requireStudentCheckInPin: boolean;
  rows: KioskStudentRow[];
  onCheckInDoneAction?: () => void;
};

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, "");
}

function matchesRow(row: KioskStudentRow, q: string, mode: SearchMode): boolean {
  const nq = normalizeQuery(q);
  if (!nq) return false;
  if (mode === "name") {
    if (normalizeQuery(row.name).includes(nq)) return true;
    if (row.parentName && normalizeQuery(row.parentName).includes(nq)) return true;
    return false;
  }
  const phoneQ = nq.replace(/\D/g, "");
  if (phoneQ.length > 0 && row.phoneLast4?.includes(phoneQ)) return true;
  return false;
}

function callableMessage(err: unknown, fallback: string): string {
  if (err instanceof FirebaseError && err.message) return err.message;
  return fallback;
}

const CHECK_IN_AUTO_CLOSE_SEC = 5;

function CheckInSuccessModal({
  student,
  onClose,
}: {
  student: KioskStudentRow;
  onClose: () => void;
}) {
  const [remaining, setRemaining] = useState(CHECK_IN_AUTO_CLOSE_SEC);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const interval = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          onCloseRef.current();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const nowStr = new Date().toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul",
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-live="assertive"
    >
      <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-neutral-900 p-8 shadow-2xl text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/40">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M5 13l4 4L19 7" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <p className="text-xl font-bold text-foreground">출석 완료</p>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          <span className="font-semibold text-foreground">{student.name}</span> 학생
        </p>
        <p className="mt-1 text-xs text-neutral-400">{nowStr} 출석 처리됨</p>
        <button
          type="button"
          onClick={onClose}
          className="mt-8 w-full rounded-2xl bg-[#222] dark:bg-neutral-100 py-3.5 text-sm font-semibold text-white dark:text-neutral-950"
        >
          확인 ({remaining})
        </button>
      </div>
    </div>
  );
}

const MODE_OPTIONS: { id: SearchMode; label: string }[] = [
  { id: "phone", label: "전화번호" },
  { id: "name", label: "이름" },
];

export function AcademyKioskPanel({
  academyId,
  requireStudentCheckInPin,
  rows,
  onCheckInDoneAction,
}: Props) {
  const [searchMode, setSearchMode] = useState<SearchMode>("phone");
  const [query, setQuery] = useState("");
  const [confirmStudent, setConfirmStudent] = useState<KioskStudentRow | null>(null);
  const [pinStudent, setPinStudent] = useState<KioskStudentRow | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkInSuccessStudent, setCheckInSuccessStudent] = useState<KioskStudentRow | null>(null);

  const trimmedQuery = query.trim();
  const showResults = trimmedQuery.length > 0;
  const keyboardHidden = Boolean(confirmStudent || pinStudent);

  const filtered = useMemo(
    () =>
      showResults
        ? rows.filter((r) => matchesRow(r, trimmedQuery, searchMode)).slice(0, 40)
        : [],
    [rows, trimmedQuery, showResults, searchMode],
  );

  const switchSearchMode = (mode: SearchMode) => {
    if (mode === searchMode) return;
    setSearchMode(mode);
    setQuery("");
  };

  const appendPhoneDigit = useCallback((digit: string) => {
    setQuery((prev) => (prev + digit).replace(/\D/g, "").slice(0, 4));
  }, []);

  const backspacePhone = useCallback(() => {
    setQuery((prev) => prev.slice(0, -1));
  }, []);

  const appendJamo = useCallback((jamo: string) => {
    setQuery((prev) => appendHangulJamo(prev, jamo));
  }, []);

  const appendSpace = useCallback(() => {
    setQuery((prev) => `${prev} `);
  }, []);

  const backspaceName = useCallback(() => {
    setQuery((prev) => backspaceHangul(prev));
  }, []);

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
        setConfirmStudent(null);
        setPinStudent(null);
        setQuery("");
        setCheckInSuccessStudent(student);
        onCheckInDoneAction?.();
      } catch (err) {
        const msg = callableMessage(err, "출석 처리에 실패했습니다.");
        if (pinStudent) {
          setPinError(msg);
        } else {
          setCheckInSuccessStudent(null);
          alert(msg);
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

  const searchPlaceholder =
    searchMode === "phone" ? "전화번호 끝 4자리" : "학생 · 학부모 이름";

  return (
    <div className="flex min-h-[50dvh] flex-col">
      <div className="sticky top-[calc(max(0.85rem,env(safe-area-inset-top))+3.25rem)] z-20 -mx-4 bg-background/90 px-4 pb-3 pt-2 backdrop-blur-md">
        <div
          className="mb-2 flex rounded-full border border-white/55 bg-white/30 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] backdrop-blur-md dark:border-white/15 dark:bg-white/8"
          role="tablist"
          aria-label="검색 방식"
        >
          {MODE_OPTIONS.map(({ id, label }) => {
            const active = searchMode === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => switchSearchMode(id)}
                className={`flex-1 rounded-full py-2 text-sm font-medium transition ${
                  active
                    ? "bg-white text-foreground shadow-sm dark:bg-neutral-800 dark:text-neutral-50"
                    : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

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
              readOnly
              inputMode="none"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={searchPlaceholder}
              value={query}
              onChange={() => {}}
              onFocus={(e) => e.currentTarget.blur()}
              className="h-9 min-w-0 flex-1 cursor-default bg-transparent text-base text-foreground outline-none ring-0 placeholder:text-neutral-400"
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
        {searchMode === "name" ? (
          <p className="mt-2 text-center text-xs text-neutral-500 dark:text-neutral-400">
            전화번호가 없는 학생은 이름으로 검색해 주세요.
          </p>
        ) : null}
      </div>

      {checkInSuccessStudent ? (
        <CheckInSuccessModal
          student={checkInSuccessStudent}
          onClose={() => setCheckInSuccessStudent(null)}
        />
      ) : null}

      {showResults ? (
        <ul className="flex flex-1 flex-col gap-2 pb-[20rem]">
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
      ) : (
        <div className="flex-1 pb-[20rem]" aria-hidden />
      )}

      {!keyboardHidden ? (
        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-lg">
          {searchMode === "phone" ? (
            <KioskNumericKeypad
              onDigitAction={appendPhoneDigit}
              onBackspaceAction={backspacePhone}
            />
          ) : (
            <KioskHangulKeyboard
              onJamoAction={appendJamo}
              onSpaceAction={appendSpace}
              onBackspaceAction={backspaceName}
            />
          )}
        </div>
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
