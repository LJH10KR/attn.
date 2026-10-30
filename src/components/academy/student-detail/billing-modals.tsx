"use client";

import { FirebaseError } from "firebase/app";
import {
  arrayUnion,
  collection,
  deleteField,
  doc,
  getDoc,
  increment,
  runTransaction,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { StudentTuitionTarget } from "@/lib/academy/student-row";
import {
  academySessionTuitionSettingsPath,
  academyStudentSessionLogsPath,
  type TuitionType,
} from "@/lib/firebase/attn-schema";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

/**
 * 학생 원비·회차 모달(원비 설정·충전·수업 완료 확인)과 그 쓰기 — 예전 원생 패널에서 옮김(2-E).
 * 원비·회차 필드는 4단계까지 클라이언트가 규칙 허용 범위에서 직접 쓴다(D11).
 * 노출 권한은 `studentAccess`(원비 설정·충전 = tuitionEdit, 수업 완료 = sessionComplete).
 */

const glassCard = "glass-card";

const inputClass =
  "min-w-0 w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-2.5 text-sm text-foreground shadow-inner outline-none placeholder:text-neutral-400 focus:border-[#4a90e2]/50 focus:bg-white/70";

function fsErr(err: unknown): string {
  if (err instanceof FirebaseError) {
    return err.message || "요청에 실패했습니다.";
  }
  return err instanceof Error && err.message ? err.message : "요청에 실패했습니다.";
}

/** 수업 완료 — 잔여 회차 1 차감 + sessionLogs 기록(잔여 0 이하면 초과 수업 날짜 추가) */
export async function recordStudentSessionComplete(academyId: string, studentId: string): Promise<void> {
  const uid = getFirebaseAuth().currentUser?.uid;
  if (!uid) throw new Error("로그인 상태를 확인해 주세요.");
  const db = getFirebaseDb();
  await runTransaction(db, async (txn) => {
    const studentRef = doc(db, "academies", academyId, "students", studentId);
    const snap = await txn.get(studentRef);
    if (!snap.exists()) throw new Error("학생 정보를 찾을 수 없습니다.");
    const data = snap.data();
    const currentBalance = typeof data.sessionBalance === "number" ? data.sessionBalance : 0;
    const wasExtra = currentBalance <= 0;
    const logRef = doc(collection(db, academyStudentSessionLogsPath(academyId, studentId)));
    txn.set(logRef, { recordedAt: serverTimestamp(), recordedByUid: uid, wasExtra });
    const updates: Record<string, unknown> = {
      sessionBalance: currentBalance - 1,
      updatedAt: serverTimestamp(),
    };
    if (wasExtra) {
      const todayKST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
      updates.extraSessionDates = arrayUnion(todayKST);
    }
    txn.update(studentRef, updates);
  });
}

/** 회차 충전 — 부채가 다 갚아지면 초과 수업 기록 초기화, 납부 안내 상태 초기화 */
export async function chargeStudentSessions(
  academyId: string,
  student: StudentTuitionTarget,
  n: number,
): Promise<void> {
  const newBalance = (student.sessionBalance ?? 0) + n;
  await updateDoc(doc(getFirebaseDb(), "academies", academyId, "students", student.id), {
    sessionBalance: increment(n),
    // 충전 후에도 잔여가 0 미만이면(부채가 다 안 갚아졌으면) 초과 수업 기록을 유지
    ...(newBalance >= 0 ? { extraSessionDates: deleteField() } : {}),
    sentSessionPaymentReminder: deleteField(),
    tuitionReminderConfirmedAt: deleteField(),
    tuitionReminderConfirmedByUid: deleteField(),
    updatedAt: serverTimestamp(),
  });
}

export function TuitionSettingModal({
  academyId,
  student,
  onClose,
  onSaved,
}: {
  academyId: string;
  student: StudentTuitionTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [academyDefaultType, setAcademyDefaultType] = useState<TuitionType>("monthly_fixed");
  // null = 학원 기본값 사용, 명시적 값 = 학생별 재정의
  const [selectedType, setSelectedType] = useState<TuitionType | null>(student.tuitionType ?? null);

  // 매월 지정일 필드
  const [dayInput, setDayInput] = useState(
    student.tuitionDueDayOfMonth != null ? String(student.tuitionDueDayOfMonth) : "",
  );
  const [amountInput, setAmountInput] = useState(
    student.tuitionAmount != null ? String(student.tuitionAmount) : "",
  );

  // 회차 방식 필드
  const [weeklyCountInput, setWeeklyCountInput] = useState(
    student.weeklySessionCount != null ? String(student.weeklySessionCount) : "",
  );
  const [priceInput, setPriceInput] = useState(
    student.pricePerSession != null ? String(student.pricePerSession) : "",
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useBodyScrollLock(true);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // 학원 기본 납부 방식 로드
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const db = getFirebaseDb();
      const snap = await getDoc(doc(db, academySessionTuitionSettingsPath(academyId)));
      if (cancelled) return;
      if (snap.exists()) {
        const d = snap.data();
        setAcademyDefaultType(
          d.defaultTuitionType === "session_based" ? "session_based" : "monthly_fixed",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyId]);

  const effectiveType = selectedType ?? academyDefaultType;

  const onSave = async () => {
    setError(null);
    const db = getFirebaseDb();
    const ref = doc(db, "academies", academyId, "students", student.id);

    if (effectiveType === "monthly_fixed") {
      const rawDay = dayInput.trim();
      let dayNum: number | undefined;
      if (rawDay) {
        dayNum = Number.parseInt(rawDay, 10);
        if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 31) {
          setError("납부 기준일은 1~31 사이의 정수로 입력해 주세요.");
          return;
        }
      }
      let amountNum: number | undefined;
      const rawAmount = amountInput.trim();
      if (rawAmount) {
        amountNum = Number(rawAmount);
        if (!Number.isFinite(amountNum) || amountNum < 0 || !Number.isInteger(amountNum)) {
          setError("원비 금액은 0 이상의 정수로 입력해 주세요.");
          return;
        }
      }
      setBusy(true);
      try {
        await updateDoc(ref, {
          tuitionType: selectedType !== null ? selectedType : deleteField(),
          tuitionDueDayOfMonth: dayNum !== undefined ? dayNum : deleteField(),
          tuitionAmount: amountNum !== undefined ? amountNum : deleteField(),
          // 회차 방식 필드 초기화
          weeklySessionCount: deleteField(),
          pricePerSession: deleteField(),
          updatedAt: serverTimestamp(),
        });
        onSaved();
        onClose();
      } catch (e) {
        setError(fsErr(e));
      } finally {
        setBusy(false);
      }
    } else {
      // session_based
      const rawCount = weeklyCountInput.trim();
      if (!rawCount) {
        setError("주당 수업 횟수를 입력해 주세요.");
        return;
      }
      const countNum = Number.parseInt(rawCount, 10);
      if (!Number.isInteger(countNum) || countNum < 1 || countNum > 7) {
        setError("주당 수업 횟수는 1~7 사이의 정수로 입력해 주세요.");
        return;
      }
      const rawPrice = priceInput.trim();
      if (!rawPrice) {
        setError("회차당 수업료를 입력해 주세요.");
        return;
      }
      const priceNum = Number(rawPrice);
      if (!Number.isFinite(priceNum) || priceNum < 0 || !Number.isInteger(priceNum)) {
        setError("회차당 수업료는 0 이상의 정수로 입력해 주세요.");
        return;
      }
      setBusy(true);
      try {
        await updateDoc(ref, {
          tuitionType: selectedType !== null ? selectedType : deleteField(),
          weeklySessionCount: countNum,
          pricePerSession: priceNum,
          // 매월 지정일 필드 초기화
          tuitionDueDayOfMonth: deleteField(),
          tuitionAmount: deleteField(),
          sentTuitionReminders: deleteField(),
          updatedAt: serverTimestamp(),
        });
        onSaved();
        onClose();
      } catch (e) {
        setError(fsErr(e));
      } finally {
        setBusy(false);
      }
    }
  };

  const onClear = async () => {
    setBusy(true);
    setError(null);
    try {
      const db = getFirebaseDb();
      await updateDoc(doc(db, "academies", academyId, "students", student.id), {
        tuitionType: deleteField(),
        tuitionDueDayOfMonth: deleteField(),
        tuitionAmount: deleteField(),
        sentTuitionReminders: deleteField(),
        weeklySessionCount: deleteField(),
        pricePerSession: deleteField(),
        sessionBalance: deleteField(),
        extraSessionDates: deleteField(),
        updatedAt: serverTimestamp(),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(fsErr(e));
    } finally {
      setBusy(false);
    }
  };

  const typeOptions: { value: TuitionType | null; label: string }[] = [
    {
      value: null,
      label: `학원 기본값 (${academyDefaultType === "session_based" ? "회차 방식" : "매월 지정일"})`,
    },
    { value: "monthly_fixed", label: "매월 지정일" },
    { value: "session_based", label: "회차 방식" },
  ];

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tuition-setting-title"
        className={`${glassCard} w-full max-w-md max-h-[min(90dvh,640px)] overflow-y-auto p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="tuition-setting-title" className="text-base font-semibold text-foreground">
          원비 설정
        </h2>
        <p className="mt-1 text-xs text-neutral-700">
          대상: <span className="font-medium text-foreground">{student.name}</span>
        </p>

        {/* 납부 방식 선택 */}
        <div className="mt-4">
          <p className="mb-2 text-xs font-medium text-neutral-600">납부 방식</p>
          <div className="flex rounded-2xl border border-neutral-300/60 bg-white/30 dark:border-white/10 dark:bg-white/[0.04] overflow-hidden">
            {typeOptions.map(({ value, label }) => (
              <button
                key={String(value)}
                type="button"
                disabled={busy}
                onClick={() => {
                  setSelectedType(value);
                  setError(null);
                }}
                className={`flex-1 px-2 py-2 text-[11px] font-medium transition ${
                  selectedType === value
                    ? "bg-[#222] text-white dark:bg-neutral-100 dark:text-neutral-950"
                    : "text-neutral-600 hover:bg-white/50 dark:text-neutral-400"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 매월 지정일 필드 */}
        {effectiveType === "monthly_fixed" ? (
          <div className="mt-4 space-y-3">
            <p className="text-[11px] text-neutral-500">
              설정한 날짜를 기준으로 매달 D-1·D-0에 학부모에게 알림이 발송됩니다.
            </p>
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="ts-day">
                납부 기준일 (매월)
              </label>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-sm text-neutral-600">매월</span>
                <input
                  id="ts-day"
                  type="number"
                  min={1}
                  max={31}
                  step={1}
                  className={inputClass}
                  placeholder="예: 25"
                  value={dayInput}
                  onChange={(e) => setDayInput(e.target.value)}
                  disabled={busy}
                />
                <span className="shrink-0 text-sm text-neutral-600">일</span>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="ts-amount">
                원비 금액 (원){" "}
                <span className="font-normal text-neutral-400">(선택)</span>
              </label>
              <input
                id="ts-amount"
                type="number"
                min={0}
                step={1}
                className={inputClass}
                placeholder="예: 300000"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                disabled={busy}
              />
            </div>
          </div>
        ) : (
          /* 회차 방식 필드 */
          <div className="mt-4 space-y-3">
            <p className="text-[11px] text-neutral-500">
              잔여 횟수가 주당 횟수 이하로 떨어지면 학부모에게 납부 안내 알림이 발송됩니다.
            </p>
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="ts-weekly">
                주당 기본 수업 횟수
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="ts-weekly"
                  type="number"
                  min={1}
                  max={7}
                  step={1}
                  className={inputClass}
                  placeholder="예: 4"
                  value={weeklyCountInput}
                  onChange={(e) => setWeeklyCountInput(e.target.value)}
                  disabled={busy}
                />
                <span className="shrink-0 text-sm text-neutral-600">회 / 주</span>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="ts-price">
                회차당 수업료 (원)
              </label>
              <input
                id="ts-price"
                type="number"
                min={0}
                step={1}
                className={inputClass}
                placeholder="예: 70000"
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
                disabled={busy}
              />
            </div>
            {student.sessionBalance != null ? (
              <div className="rounded-xl bg-white/50 dark:bg-white/[0.06] px-4 py-3">
                <p className="text-[11px] text-neutral-500">현재 잔여 횟수</p>
                <p className={`mt-0.5 text-sm font-semibold ${student.sessionBalance < 0 ? "text-red-600" : "text-foreground"}`}>
                  {student.sessionBalance}회
                  {student.sessionBalance < 0 ? " (초과 수업)" : ""}
                </p>
              </div>
            ) : null}
          </div>
        )}

        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}

        <div className="mt-6 flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={busy}
            className="rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
            onClick={() => void onClear()}
          >
            {busy ? "처리 중…" : "초기화"}
          </button>
          <div className="flex gap-2">
            <button
              ref={closeRef}
              type="button"
              disabled={busy}
              className="rounded-2xl border border-neutral-300/80 bg-white/80 px-4 py-2.5 text-sm font-medium text-neutral-800 disabled:opacity-50"
              onClick={onClose}
            >
              취소
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-2xl bg-[#222] dark:bg-neutral-100 px-4 py-2.5 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-50"
              onClick={() => void onSave()}
            >
              {busy ? "저장 중…" : "저장"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function SessionCompleteConfirmModal({
  student,
  onConfirm,
  onCancel,
  busy,
}: {
  student: StudentTuitionTarget;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  useBodyScrollLock(true);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const currentBalance = student.sessionBalance ?? 0;
  const afterBalance = currentBalance - 1;
  const isExtra = currentBalance <= 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={() => { if (!busy) onCancel(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`${glassCard} w-full max-w-sm p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-foreground">수업 완료 기록</h2>
        <p className="mt-1 text-xs text-neutral-600">
          대상: <span className="font-medium text-foreground">{student.name}</span>
        </p>
        <div className="mt-4 rounded-2xl bg-white/50 dark:bg-white/[0.06] px-4 py-3 space-y-1.5">
          <div className="flex justify-between text-sm">
            <span className="text-neutral-600">현재 잔여 횟수</span>
            <span className={`font-medium ${currentBalance <= 0 ? "text-red-600" : "text-foreground"}`}>
              {currentBalance}회
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-neutral-600">수업 완료 후</span>
            <span className={`font-semibold ${afterBalance < 0 ? "text-red-600" : "text-foreground"}`}>
              {afterBalance}회
            </span>
          </div>
        </div>
        {isExtra ? (
          <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-[11px] text-red-700">
            잔여 횟수가 부족합니다. 오늘 수업은 <span className="font-semibold">초과 수업</span>으로 기록되며 다음 납부 안내에 포함됩니다.
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            className="rounded-2xl border border-neutral-300/80 bg-white/80 px-4 py-2.5 text-sm font-medium text-neutral-800 disabled:opacity-50"
            onClick={onCancel}
          >
            취소
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded-2xl bg-[#222] dark:bg-neutral-100 px-4 py-2.5 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-50"
            onClick={onConfirm}
          >
            {busy ? "기록 중…" : "수업 완료"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ChargeSessionModal({
  student,
  onConfirm,
  onCancel,
  busy,
}: {
  student: StudentTuitionTarget;
  onConfirm: (n: number) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [input, setInput] = useState(() => {
    const wc = student.weeklySessionCount;
    return wc != null && wc >= 1 ? String(wc * 4) : "1";
  });
  useBodyScrollLock(true);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const n = Number.parseInt(input.trim(), 10);
  const valid = Number.isInteger(n) && n >= 1 && n <= 999;
  const currentBalance = student.sessionBalance ?? 0;
  const afterBalance = valid ? currentBalance + n : null;
  const hasDebt = currentBalance < 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={() => { if (!busy) onCancel(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`${glassCard} w-full max-w-sm p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-foreground">수업 횟수 충전</h2>
        <p className="mt-1 text-xs text-neutral-600">
          대상: <span className="font-medium text-foreground">{student.name}</span>
        </p>
        <div className="mt-4 space-y-3">
          <div className="rounded-2xl bg-white/50 dark:bg-white/[0.06] px-4 py-3 space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-neutral-600">현재 잔여 횟수</span>
              <span className={`font-medium ${currentBalance < 0 ? "text-red-600" : "text-foreground"}`}>
                {currentBalance}회{currentBalance < 0 ? " (초과 수업 부채)" : ""}
              </span>
            </div>
            {afterBalance !== null ? (
              <div className="flex justify-between text-sm">
                <span className="text-neutral-600">충전 후</span>
                <span className={`font-semibold ${afterBalance < 0 ? "text-red-600" : "text-violet-700"}`}>
                  {afterBalance}회
                </span>
              </div>
            ) : null}
          </div>
          {hasDebt ? (
            <p className="text-[11px] text-amber-700 rounded-xl bg-amber-50 px-3 py-2">
              초과 수업 부채가 있습니다.{" "}
              {afterBalance !== null && afterBalance >= 0
                ? "충전 후 초과 수업 기록이 초기화됩니다."
                : "충전 후에도 잔여가 0 미만이라 초과 수업 기록은 유지됩니다."}
            </p>
          ) : null}
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="charge-n">
              충전 횟수
            </label>
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                id="charge-n"
                type="number"
                min={1}
                max={999}
                step={1}
                className={inputClass}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={busy}
                onKeyDown={(e) => { if (e.key === "Enter" && valid && !busy) onConfirm(n); }}
              />
              <span className="shrink-0 text-sm text-neutral-600">회</span>
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            className="rounded-2xl border border-neutral-300/80 bg-white/80 px-4 py-2.5 text-sm font-medium text-neutral-800 disabled:opacity-50"
            onClick={onCancel}
          >
            취소
          </button>
          <button
            type="button"
            disabled={busy || !valid}
            className="rounded-2xl bg-violet-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
            onClick={() => { if (valid) onConfirm(n); }}
          >
            {busy ? "충전 중…" : `${valid ? n : ""}회 충전`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
