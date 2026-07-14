"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import {
  arrayUnion,
  collection,
  deleteField,
  doc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  academySessionTuitionSettingsPath,
  academyStudentSessionLogsPath,
  MAX_ASSIGNED_TEACHERS_PER_STUDENT,
  type TeacherRegistrationStatus,
  type TuitionType,
} from "@/lib/firebase/attn-schema";
import { getFirebaseAuth, getFirebaseDb, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { AcademyPanelRefreshButton } from "@/components/academy/academy-panel-refresh-button";
import { useAcademyListPoll } from "@/lib/firebase/use-academy-list-poll";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";
import { KrPhoneInput } from "@/components/ui/kr-phone-input";
import { formatKrPhoneDisplay, phoneMatchesSearch } from "@/lib/phone/kr-phone";

const glassCard = "glass-card";

const inputClass =
  "min-w-0 w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-2.5 text-sm text-foreground shadow-inner outline-none placeholder:text-neutral-400 focus:border-[#4a90e2]/50 focus:bg-white/70";

const miniBtnClass =
  "rounded-lg border border-neutral-300/70 bg-white/55 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-white/90 disabled:opacity-45";

export type StudentRowVM = {
  id: string;
  parentUserId: string;
  name: string;
  age: number;
  phone: string;
  emergencyContact: string;
  /** 병합된 전담 선생 uid — 구 `assignedTeacherUid` 단일 필드는 읽을 때 여기에 합쳐짐 */
  assignedTeacherUids: string[];
  createdAt?: Timestamp;
  /** 매월 지정일 납부 */
  tuitionDueDayOfMonth?: number | null;
  tuitionAmount?: number | null;
  /** 회차 방식 납부 */
  tuitionType?: TuitionType | null;
  weeklySessionCount?: number | null;
  pricePerSession?: number | null;
  sessionBalance?: number | null;
};

type StudentRowWithParent = StudentRowVM & { parentName: string; teacherLabel: string };

type TeacherBrief = { id: string; name: string; status: TeacherRegistrationStatus };

function fsErr(err: unknown): string {
  if (err instanceof FirebaseError) {
    return err.message || "요청에 실패했습니다.";
  }
  return "요청에 실패했습니다.";
}

function mergeAssignedTeacherUidsFromDoc(data: Record<string, unknown>): string[] {
  const raw = data.assignedTeacherUids;
  const fromList =
    Array.isArray(raw) && raw.every((x) => typeof x === "string")
      ? (raw as string[]).filter((x) => x.length > 0)
      : [];
  const legacy = data.assignedTeacherUid;
  const legacyOne = typeof legacy === "string" && legacy.length > 0 ? legacy : null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of fromList) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  if (legacyOne && !seen.has(legacyOne)) {
    out.push(legacyOne);
  }
  return out;
}

export function docToStudentRow(id: string, data: Record<string, unknown>): StudentRowVM {
  const ageRaw = data.age;
  const age =
    typeof ageRaw === "number" && Number.isFinite(ageRaw)
      ? Math.max(0, Math.floor(ageRaw))
      : 0;
  const createdAt = data.createdAt;
  const assignedTeacherUids = mergeAssignedTeacherUidsFromDoc(data);

  const rawDueDayOfMonth = data.tuitionDueDayOfMonth;
  const tuitionDueDayOfMonth =
    typeof rawDueDayOfMonth === "number" &&
    Number.isInteger(rawDueDayOfMonth) &&
    rawDueDayOfMonth >= 1 &&
    rawDueDayOfMonth <= 31
      ? rawDueDayOfMonth
      : null;

  const rawTuitionType = data.tuitionType;
  const tuitionType: TuitionType | null =
    rawTuitionType === "monthly_fixed" || rawTuitionType === "session_based"
      ? rawTuitionType
      : null;

  const rawWeeklyCount = data.weeklySessionCount;
  const weeklySessionCount =
    typeof rawWeeklyCount === "number" &&
    Number.isInteger(rawWeeklyCount) &&
    rawWeeklyCount >= 1 &&
    rawWeeklyCount <= 7
      ? rawWeeklyCount
      : null;

  const rawPrice = data.pricePerSession;
  const pricePerSession =
    typeof rawPrice === "number" && rawPrice >= 0 ? rawPrice : null;

  const rawBalance = data.sessionBalance;
  const sessionBalance =
    typeof rawBalance === "number" && Number.isInteger(rawBalance) ? rawBalance : null;

  return {
    id,
    parentUserId: typeof data.parentUserId === "string" ? data.parentUserId : "",
    name: typeof data.name === "string" ? data.name : "",
    age,
    phone: typeof data.phone === "string" ? data.phone : "",
    emergencyContact: typeof data.emergencyContact === "string" ? data.emergencyContact : "",
    assignedTeacherUids,
    createdAt:
      createdAt &&
      typeof createdAt === "object" &&
      "toMillis" in createdAt &&
      typeof (createdAt as Timestamp).toMillis === "function"
        ? (createdAt as Timestamp)
        : undefined,
    tuitionDueDayOfMonth,
    tuitionAmount: typeof data.tuitionAmount === "number" ? data.tuitionAmount : null,
    tuitionType,
    weeklySessionCount,
    pricePerSession,
    sessionBalance,
  };
}

function sortStudentsByCreated(a: StudentRowVM, b: StudentRowVM): number {
  return (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0);
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="2" />
      <path d="M15 15l6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ChevronRightGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EditStudentModal({
  academyId,
  student,
  open,
  busy,
  error,
  formName,
  setFormName,
  formAge,
  setFormAge,
  formPhone,
  setFormPhone,
  formEmergency,
  setFormEmergency,
  onClose,
  onSubmit,
}: {
  academyId: string;
  student: StudentRowVM;
  open: boolean;
  busy: boolean;
  error: string | null;
  formName: string;
  setFormName: (v: string) => void;
  formAge: string;
  setFormAge: (v: string) => void;
  formPhone: string;
  setFormPhone: (v: string) => void;
  formEmergency: string;
  setFormEmergency: (v: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  useBodyScrollLock(open);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-student-title"
        className={`${glassCard} w-full max-w-md max-h-[min(90dvh,640px)] overflow-y-auto p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="edit-student-title" className="text-base font-semibold text-foreground">
          학생 정보 수정
        </h2>
        <p className="mt-1 text-xs text-neutral-700">
          대상: <span className="font-medium text-foreground">{student.name}</span>
        </p>
        <p className="mt-0.5 text-[11px] text-neutral-500">
          학원 ID: <span className="font-mono">{academyId}</span>
        </p>
        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="es-name">
              이름
            </label>
            <input
              id="es-name"
              className={inputClass}
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              maxLength={80}
              disabled={busy}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="es-age">
              나이
            </label>
            <input
              id="es-age"
              type="number"
              min={0}
              max={120}
              className={inputClass}
              value={formAge}
              onChange={(e) => setFormAge(e.target.value)}
              disabled={busy}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="es-phone">
              연락처
            </label>
            <KrPhoneInput
              id="es-phone"
              className={inputClass}
              value={formPhone}
              onChange={setFormPhone}
              disabled={busy}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="es-em">
              비상 연락처
            </label>
            <KrPhoneInput
              id="es-em"
              className={inputClass}
              value={formEmergency}
              onChange={setFormEmergency}
              disabled={busy}
            />
          </div>
        </div>
        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            ref={ref}
            type="button"
            disabled={busy}
            className="rounded-2xl border border-neutral-300/80 bg-white/80 px-4 py-2.5 text-sm font-medium text-neutral-800"
            onClick={onClose}
          >
            취소
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded-2xl bg-[#222] dark:bg-neutral-100 px-4 py-2.5 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-50"
            onClick={() => onSubmit()}
          >
            {busy ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DeleteStudentConfirmModal({
  student,
  busy,
  onCancel,
  onConfirm,
}: {
  student: StudentRowVM;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useBodyScrollLock(true);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="del-student-title"
        className={`${glassCard} w-full max-w-md p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="del-student-title" className="text-base font-semibold text-foreground">
          학생을 삭제할까요?
        </h2>
        <p className="mt-3 text-sm text-neutral-700">
          <span className="font-medium">{student.name}</span>
          {student.age != null ? <span className="text-neutral-500"> (만 {student.age}세)</span> : null} — 이
          정보를 삭제합니다. 되돌릴 수 없습니다.
        </p>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
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
            className="rounded-2xl bg-red-700 px-4 py-2.5 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-50"
            onClick={onConfirm}
          >
            {busy ? "삭제 중…" : "삭제"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function TuitionSettingModal({
  academyId,
  student,
  onClose,
  onSaved,
}: {
  academyId: string;
  student: StudentRowVM;
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
    const db = getFirebaseDb();
    return onSnapshot(doc(db, academySessionTuitionSettingsPath(academyId)), (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        setAcademyDefaultType(
          d.defaultTuitionType === "session_based" ? "session_based" : "monthly_fixed",
        );
      }
    });
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

function StudentAssignedTeachersModal({
  academyId,
  student,
  onClose,
  activeTeachersSorted,
  teacherNameById,
  teacherAssignBusyId,
  onToggleTeacher,
}: {
  academyId: string;
  student: StudentRowWithParent | null;
  onClose: () => void;
  activeTeachersSorted: TeacherBrief[];
  teacherNameById: Record<string, string>;
  teacherAssignBusyId: string | null;
  onToggleTeacher: (row: StudentRowVM, teacherUid: string, add: boolean) => void;
}) {
  useBodyScrollLock(student !== null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (student) closeRef.current?.focus();
  }, [student]);
  useEffect(() => {
    if (!student) return;
    const busyHere = teacherAssignBusyId === student.id;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyHere) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [student, teacherAssignBusyId, onClose]);

  if (!student) return null;

  const busyHere = teacherAssignBusyId === student.id;
  const s = student;

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={() => {
        if (!busyHere) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="student-assign-teachers-title"
        className={`${glassCard} flex max-h-[min(90dvh,560px)] w-full max-w-md flex-col p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="student-assign-teachers-title" className="shrink-0 text-base font-semibold text-foreground">
          전담 선생님
        </h2>
        <p className="mt-1 shrink-0 text-xs text-neutral-600">
          <span className="font-medium text-foreground">{s.name}</span>
          <span className="text-neutral-500"> · 만 {s.age}세</span>
        </p>
        <p className="mt-0.5 shrink-0 text-[11px] text-neutral-500">
          학부모: <span className="font-medium text-foreground">{s.parentName}</span>
          <span className="font-mono text-[10px] text-neutral-400"> ({s.parentUserId})</span>
        </p>
        <p className="mt-2 shrink-0 text-[11px] leading-relaxed text-neutral-600">
          활성 선생님을 복수 선택할 수 있습니다. 학생당 최대{" "}
          {MAX_ASSIGNED_TEACHERS_PER_STUDENT}명 · 학원{" "}
          <span className="font-mono text-[10px] text-foreground">{academyId}</span>
        </p>
        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
          <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-white/60 bg-white/25 px-2 py-2">
            <p className="mb-1.5 px-1 text-[11px] font-medium text-neutral-600">활성 선생님</p>
            <div className="max-h-48 space-y-0.5 overflow-y-auto">
              {activeTeachersSorted.length === 0 ? (
                <p className="px-1 py-2 text-xs text-neutral-500">활성 선생님이 없습니다.</p>
              ) : (
                activeTeachersSorted.map((t) => {
                  const on = s.assignedTeacherUids.includes(t.id);
                  const atCap =
                    !on && s.assignedTeacherUids.length >= MAX_ASSIGNED_TEACHERS_PER_STUDENT;
                  return (
                    <label
                      key={t.id}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-1 py-1.5 text-[11px] text-foreground hover:bg-white/50"
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={busyHere || atCap}
                        onChange={() => onToggleTeacher(s, t.id, !on)}
                        className="h-3.5 w-3.5 rounded border-neutral-400"
                      />
                      <span>{t.name || t.id}</span>
                    </label>
                  );
                })
              )}
            </div>
          </div>
          {s.assignedTeacherUids.some((tid) => !activeTeachersSorted.some((t) => t.id === tid)) ? (
            <div className="shrink-0 overflow-y-auto rounded-xl border border-amber-500/20 bg-amber-500/5 px-2 py-2">
              <p className="mb-1 px-1 text-[11px] font-medium text-amber-950/90">비활성·기타 전담</p>
              <ul className="space-y-1 text-[11px] text-amber-950">
                {s.assignedTeacherUids
                  .filter((tid) => !activeTeachersSorted.some((t) => t.id === tid))
                  .map((tid) => (
                    <li
                      key={tid}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/40 bg-white/30 px-2 py-1.5"
                    >
                      <span>
                        {teacherNameById[tid] ?? tid}
                        <span className="text-neutral-700"> (연결 해제만 가능)</span>
                      </span>
                      <button
                        type="button"
                        className={miniBtnClass}
                        disabled={busyHere}
                        onClick={() => onToggleTeacher(s, tid, false)}
                      >
                        제거
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
        </div>
        <div className="mt-6 flex shrink-0 justify-end">
          <button
            ref={closeRef}
            type="button"
            disabled={busyHere}
            className="rounded-2xl border border-neutral-300/80 bg-white/80 px-4 py-2.5 text-sm font-medium text-neutral-800 disabled:opacity-50"
            onClick={onClose}
          >
            {busyHere ? "저장 중…" : "닫기"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SessionCompleteConfirmModal({
  student,
  onConfirm,
  onCancel,
  busy,
}: {
  student: StudentRowVM;
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

/** 학부모 카드 확장 영역 — 해당 학부모의 자녀만 */
export function AcademyParentStudentList({
  academyId,
  parentUserId,
  setNoticeAction,
}: {
  academyId: string;
  parentUserId: string;
  setNoticeAction: (msg: string | null) => void;
}) {
  const [teacherNames, setTeacherNames] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<StudentRowVM[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<StudentRowVM | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StudentRowVM | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [formName, setFormName] = useState("");
  const [formAge, setFormAge] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formEmergency, setFormEmergency] = useState("");
  const [notifyBusyKey, setNotifyBusyKey] = useState<string | null>(null);
  const [tuitionModalTarget, setTuitionModalTarget] = useState<StudentRowVM | null>(null);
  const [sessionConfirmTarget, setSessionConfirmTarget] = useState<StudentRowVM | null>(null);
  const [sessionCompleteBusy, setSessionCompleteBusy] = useState(false);

  const loadParentChildren = useCallback(async () => {
    try {
      const db = getFirebaseDb();
      const [teachersSnap, studentsSnap] = await Promise.all([
        getDocs(collection(db, "academies", academyId, "teachers")),
        getDocs(
          query(
            collection(db, "academies", academyId, "students"),
            where("parentUserId", "==", parentUserId),
          ),
        ),
      ]);
      const m: Record<string, string> = {};
      for (const d of teachersSnap.docs) {
        const data = d.data() as { displayName?: string };
        m[d.id] = typeof data.displayName === "string" && data.displayName ? data.displayName : d.id;
      }
      setTeacherNames(m);
      const list = studentsSnap.docs.map((d) =>
        docToStudentRow(d.id, d.data() as Record<string, unknown>),
      );
      list.sort(sortStudentsByCreated);
      setRows(list);
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "목록을 불러오지 못했습니다.");
      setRows([]);
    }
  }, [academyId, parentUserId]);

  const { refresh: refreshParentChildren } = useAcademyListPoll(loadParentChildren, [
    academyId,
    parentUserId,
  ]);

  const recordSessionComplete = useCallback(async (student: StudentRowVM) => {
    const uid = getFirebaseAuth().currentUser?.uid;
    if (!uid) { setNoticeAction("로그인 상태를 확인해 주세요."); return; }
    setSessionCompleteBusy(true);
    try {
      const db = getFirebaseDb();
      await runTransaction(db, async (txn) => {
        const studentRef = doc(db, "academies", academyId, "students", student.id);
        const snap = await txn.get(studentRef);
        if (!snap.exists()) throw new Error("학생 정보를 찾을 수 없습니다.");
        const data = snap.data();
        const currentBalance = typeof data.sessionBalance === "number" ? data.sessionBalance : 0;
        const wasExtra = currentBalance <= 0;
        const logRef = doc(collection(db, academyStudentSessionLogsPath(academyId, student.id)));
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
      setNoticeAction(`${student.name} 수업 완료 기록이 저장되었습니다.`);
      setSessionConfirmTarget(null);
      refreshParentChildren();
    } catch (e) {
      setNoticeAction(fsErr(e));
    } finally {
      setSessionCompleteBusy(false);
    }
  }, [academyId, refreshParentChildren, setNoticeAction]);

  const openEdit = (s: StudentRowVM) => {
    setEditErr(null);
    setFormName(s.name);
    setFormAge(String(s.age));
    setFormPhone(formatKrPhoneDisplay(s.phone));
    setFormEmergency(formatKrPhoneDisplay(s.emergencyContact));
    setEditTarget(s);
  };

  const closeEdit = () => {
    if (!editBusy) setEditTarget(null);
  };

  const saveEdit = useCallback(async () => {
    if (!editTarget) return;
    setEditErr(null);
    const name = formName.trim();
    if (!name || name.length > 80) {
      setEditErr("이름을 1~80자로 입력해 주세요.");
      return;
    }
    const ageNum = Number.parseInt(formAge.trim(), 10);
    if (!Number.isFinite(ageNum) || ageNum < 0 || ageNum > 120) {
      setEditErr("나이는 0~120 사이 정수로 입력해 주세요.");
      return;
    }
    const phone = formPhone.trim().slice(0, 30);
    const emergency = formEmergency.trim().slice(0, 30);
    if (!phone || !emergency) {
      setEditErr("연락처와 비상 연락처를 모두 입력해 주세요.");
      return;
    }
    setEditBusy(true);
    try {
      const db = getFirebaseDb();
      await updateDoc(doc(db, "academies", academyId, "students", editTarget.id), {
        name,
        age: ageNum,
        phone,
        emergencyContact: emergency,
        updatedAt: serverTimestamp(),
      });
      setNoticeAction("학생 정보를 저장했습니다.");
      setEditTarget(null);
      refreshParentChildren();
    } catch (e) {
      setEditErr(fsErr(e));
    } finally {
      setEditBusy(false);
    }
  }, [
    academyId,
    editTarget,
    formAge,
    formEmergency,
    formName,
    formPhone,
    setNoticeAction,
    refreshParentChildren,
  ]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDelBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "deleteAcademyStudent");
      await fn({ academyId, studentId: deleteTarget.id });
      setNoticeAction("학생을 삭제했습니다.");
      setDeleteTarget(null);
      refreshParentChildren();
    } catch (e) {
      setNoticeAction(fsErr(e));
    } finally {
      setDelBusy(false);
    }
  }, [academyId, deleteTarget, refreshParentChildren, setNoticeAction]);

  const sendAttendanceNotify = useCallback(
    async (studentId: string, kind: "present" | "absent") => {
      const key = `${studentId}-${kind}`;
      setNotifyBusyKey(key);
      try {
        const fn = httpsCallable(getFirebaseFunctions(), "sendStudentAttendanceNotification");
        await fn({ academyId, studentId, kind });
        setNoticeAction(kind === "present" ? "출석 알림을 보냈습니다." : "결석 알림을 보냈습니다.");
      } catch (e) {
        if (e instanceof FirebaseError && e.code === "functions/resource-exhausted") {
          setNoticeAction("같은 학생에게 너무 자주 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.");
        } else {
          setNoticeAction("알림을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.");
        }
      } finally {
        setNotifyBusyKey(null);
      }
    },
    [academyId, setNoticeAction],
  );

  return (
    <div className="mb-4">
      <h4 className="mb-2 text-xs font-semibold text-foreground">자녀(학생) 목록</h4>
      {listError ? (
        <p className="text-xs text-red-600">{listError}</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-neutral-500">등록된 자녀가 없습니다.</p>
      ) : (
        <ul className="max-h-48 space-y-2 overflow-y-auto pr-1">
          {rows.map((s) => (
            <li
              key={s.id}
              className="rounded-xl border border-white/60 bg-white/25 px-3 py-2 text-xs text-neutral-800"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-medium text-foreground">{s.name}</span>
                  <span className="text-neutral-500"> · 만 {s.age}세</span>
                  <div className="mt-0.5 text-[11px] text-neutral-600">
                    연락 {formatKrPhoneDisplay(s.phone) || "—"} · 비상{" "}
                    {formatKrPhoneDisplay(s.emergencyContact) || "—"}
                  </div>
                  {s.assignedTeacherUids.length > 0 ? (
                    <div className="mt-0.5 text-[11px] text-sky-900">
                      전담:{" "}
                      {s.assignedTeacherUids.map((uid, i) => (
                        <span key={uid}>
                          {i > 0 ? ", " : ""}
                          <span className="font-medium">{teacherNames[uid] ?? uid}</span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {s.tuitionDueDayOfMonth ? (
                    <div className="mt-0.5 text-[11px] text-amber-800">
                      납부일 매월{" "}
                      <span className="font-medium">{s.tuitionDueDayOfMonth}일</span>
                      {s.tuitionAmount != null ? (
                        <> · {s.tuitionAmount.toLocaleString("ko-KR")}원</>
                      ) : null}
                    </div>
                  ) : s.weeklySessionCount != null ? (
                    <div className="mt-0.5 text-[11px] text-violet-800">
                      회차 방식 · 주{s.weeklySessionCount}회
                      {s.pricePerSession != null ? (
                        <> · {s.pricePerSession.toLocaleString("ko-KR")}원/회</>
                      ) : null}
                      {s.sessionBalance != null ? (
                        <span className={s.sessionBalance < 0 ? " · 잔여 " : " · 잔여 "}>
                          {" "}·{" "}
                          <span className={s.sessionBalance < 0 ? "font-medium text-red-700" : "font-medium"}>
                            잔여 {s.sessionBalance}회
                          </span>
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    className={miniBtnClass}
                    disabled={notifyBusyKey !== null}
                    onClick={() => void sendAttendanceNotify(s.id, "present")}
                  >
                    {notifyBusyKey === `${s.id}-present` ? "전송 중…" : "출석"}
                  </button>
                  <button
                    type="button"
                    className={miniBtnClass}
                    disabled={notifyBusyKey !== null}
                    onClick={() => void sendAttendanceNotify(s.id, "absent")}
                  >
                    {notifyBusyKey === `${s.id}-absent` ? "전송 중…" : "결석"}
                  </button>
                  {s.weeklySessionCount != null ? (
                    <button
                      type="button"
                      className={`${miniBtnClass} border-violet-300/70 bg-violet-50/70 text-violet-800 hover:bg-violet-100`}
                      disabled={sessionCompleteBusy}
                      onClick={() => setSessionConfirmTarget(s)}
                    >
                      수업 완료
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={miniBtnClass}
                    onClick={() => setTuitionModalTarget(s)}
                  >
                    원비
                  </button>
                  <button type="button" className={miniBtnClass} onClick={() => openEdit(s)}>
                    수정
                  </button>
                  <button type="button" className={miniBtnClass} onClick={() => setDeleteTarget(s)}>
                    삭제
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editTarget ? (
        <EditStudentModal
          academyId={academyId}
          student={editTarget}
          open
          busy={editBusy}
          error={editErr}
          formName={formName}
          setFormName={setFormName}
          formAge={formAge}
          setFormAge={setFormAge}
          formPhone={formPhone}
          setFormPhone={setFormPhone}
          formEmergency={formEmergency}
          setFormEmergency={setFormEmergency}
          onClose={closeEdit}
          onSubmit={() => void saveEdit()}
        />
      ) : null}
      {deleteTarget ? (
        <DeleteStudentConfirmModal
          student={deleteTarget}
          busy={delBusy}
          onCancel={() => {
            if (!delBusy) setDeleteTarget(null);
          }}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
      {tuitionModalTarget ? (
        <TuitionSettingModal
          academyId={academyId}
          student={tuitionModalTarget}
          onClose={() => setTuitionModalTarget(null)}
          onSaved={() => {
            setNoticeAction("원비 납부일을 저장했습니다.");
            refreshParentChildren();
          }}
        />
      ) : null}
      {sessionConfirmTarget ? (
        <SessionCompleteConfirmModal
          student={sessionConfirmTarget}
          busy={sessionCompleteBusy}
          onCancel={() => { if (!sessionCompleteBusy) setSessionConfirmTarget(null); }}
          onConfirm={() => void recordSessionComplete(sessionConfirmTarget)}
        />
      ) : null}
    </div>
  );
}

/** 학생 탭 — 전체 학생 + 학부모 이름 + 검색 */
export function AcademyStudentPanel({ academyId }: { academyId: string }) {
  const [queryText, setQueryText] = useState("");
  const [students, setStudents] = useState<StudentRowVM[]>([]);
  const [teachers, setTeachers] = useState<TeacherBrief[]>([]);
  const [parentsById, setParentsById] = useState<Record<string, string>>({});
  const [listError, setListError] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<StudentRowVM | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StudentRowVM | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [teacherAssignBusyId, setTeacherAssignBusyId] = useState<string | null>(null);
  const [teacherModalStudentId, setTeacherModalStudentId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formAge, setFormAge] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formEmergency, setFormEmergency] = useState("");
  const [tuitionModalTarget, setTuitionModalTarget] = useState<StudentRowVM | null>(null);
  const [sessionConfirmTarget, setSessionConfirmTarget] = useState<StudentRowVM | null>(null);
  const [sessionCompleteBusy, setSessionCompleteBusy] = useState(false);

  const loadStudentPanelData = useCallback(async () => {
    try {
      const db = getFirebaseDb();
      const [studentsSnap, teachersSnap, parentsSnap] = await Promise.all([
        getDocs(query(collection(db, "academies", academyId, "students"))),
        getDocs(collection(db, "academies", academyId, "teachers")),
        getDocs(query(collection(db, "academies", academyId, "parents"))),
      ]);
      const list = studentsSnap.docs.map((d) =>
        docToStudentRow(d.id, d.data() as Record<string, unknown>),
      );
      list.sort(sortStudentsByCreated);
      setStudents(list);
      setTeachers(
        teachersSnap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>;
          return {
            id: d.id,
            name: typeof data.displayName === "string" ? data.displayName : "",
            status: (data.status as TeacherRegistrationStatus) ?? "invitation_needed",
          };
        }),
      );
      const map: Record<string, string> = {};
      for (const d of parentsSnap.docs) {
        const data = d.data() as { displayName?: string };
        map[d.id] = typeof data.displayName === "string" ? data.displayName : d.id;
      }
      setParentsById(map);
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "목록을 불러오지 못했습니다.");
      setStudents([]);
    }
  }, [academyId]);

  const { refresh: refreshStudentPanel, busy: listBusy } = useAcademyListPoll(
    loadStudentPanelData,
    [academyId],
  );

  const recordSessionComplete = useCallback(async (student: StudentRowVM) => {
    const uid = getFirebaseAuth().currentUser?.uid;
    if (!uid) { setNotice("로그인 상태를 확인해 주세요."); return; }
    setSessionCompleteBusy(true);
    try {
      const db = getFirebaseDb();
      await runTransaction(db, async (txn) => {
        const studentRef = doc(db, "academies", academyId, "students", student.id);
        const snap = await txn.get(studentRef);
        if (!snap.exists()) throw new Error("학생 정보를 찾을 수 없습니다.");
        const data = snap.data();
        const currentBalance = typeof data.sessionBalance === "number" ? data.sessionBalance : 0;
        const wasExtra = currentBalance <= 0;
        const logRef = doc(collection(db, academyStudentSessionLogsPath(academyId, student.id)));
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
      setNotice(`${student.name} 수업 완료 기록이 저장되었습니다.`);
      setSessionConfirmTarget(null);
      refreshStudentPanel();
    } catch (e) {
      setNotice(fsErr(e));
    } finally {
      setSessionCompleteBusy(false);
    }
  }, [academyId, refreshStudentPanel]);

  const teacherNameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of teachers) {
      m[t.id] = t.name || t.id;
    }
    return m;
  }, [teachers]);

  const activeTeachersSorted = useMemo(() => {
    return teachers
      .filter((t) => t.status === "active")
      .slice()
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, "ko"));
  }, [teachers]);

  const rowsWithParent = useMemo((): StudentRowWithParent[] => {
    return students.map((s) => {
      const teacherLabel = s.assignedTeacherUids
        .map((uid) => teacherNameById[uid] ?? uid)
        .join(", ");
      return {
        ...s,
        parentName: parentsById[s.parentUserId] ?? s.parentUserId,
        teacherLabel,
      };
    });
  }, [students, parentsById, teacherNameById]);

  const filtered = useMemo((): StudentRowWithParent[] => {
    const q = queryText.trim().toLowerCase();
    if (!q) return rowsWithParent;
    return rowsWithParent.filter((r) => {
      const ageStr = String(r.age);
      return (
        r.name.toLowerCase().includes(q) ||
        r.parentName.toLowerCase().includes(q) ||
        phoneMatchesSearch(r.phone, q) ||
        phoneMatchesSearch(r.emergencyContact, q) ||
        ageStr.includes(q) ||
        r.parentUserId.toLowerCase().includes(q) ||
        r.teacherLabel.toLowerCase().includes(q) ||
        r.assignedTeacherUids.some((uid) => uid.toLowerCase().includes(q))
      );
    });
  }, [rowsWithParent, queryText]);

  const teacherModalRow = useMemo((): StudentRowWithParent | null => {
    if (!teacherModalStudentId) return null;
    const s = students.find((x) => x.id === teacherModalStudentId);
    if (!s) return null;
    const teacherLabel = s.assignedTeacherUids
      .map((uid) => teacherNameById[uid] ?? uid)
      .join(", ");
    return {
      ...s,
      parentName: parentsById[s.parentUserId] ?? s.parentUserId,
      teacherLabel,
    };
  }, [teacherModalStudentId, students, parentsById, teacherNameById]);

  useEffect(() => {
    if (teacherModalStudentId && !students.some((x) => x.id === teacherModalStudentId)) {
      setTeacherModalStudentId(null);
    }
  }, [teacherModalStudentId, students]);

  const closeTeacherModal = useCallback(() => {
    setTeacherModalStudentId(null);
  }, []);

  const openEdit = (s: StudentRowVM) => {
    setTeacherModalStudentId(null);
    setEditErr(null);
    setFormName(s.name);
    setFormAge(String(s.age));
    setFormPhone(formatKrPhoneDisplay(s.phone));
    setFormEmergency(formatKrPhoneDisplay(s.emergencyContact));
    setEditTarget(s);
  };

  const closeEdit = () => {
    if (!editBusy) setEditTarget(null);
  };

  const saveEdit = useCallback(async () => {
    if (!editTarget) return;
    setEditErr(null);
    const name = formName.trim();
    if (!name || name.length > 80) {
      setEditErr("이름을 1~80자로 입력해 주세요.");
      return;
    }
    const ageNum = Number.parseInt(formAge.trim(), 10);
    if (!Number.isFinite(ageNum) || ageNum < 0 || ageNum > 120) {
      setEditErr("나이는 0~120 사이 정수로 입력해 주세요.");
      return;
    }
    const phone = formPhone.trim().slice(0, 30);
    const emergency = formEmergency.trim().slice(0, 30);
    if (!phone || !emergency) {
      setEditErr("연락처와 비상 연락처를 모두 입력해 주세요.");
      return;
    }
    setEditBusy(true);
    try {
      const db = getFirebaseDb();
      await updateDoc(doc(db, "academies", academyId, "students", editTarget.id), {
        name,
        age: ageNum,
        phone,
        emergencyContact: emergency,
        updatedAt: serverTimestamp(),
      });
      setNotice("학생 정보를 저장했습니다.");
      setEditTarget(null);
      refreshStudentPanel();
    } catch (e) {
      setEditErr(fsErr(e));
    } finally {
      setEditBusy(false);
    }
  }, [academyId, editTarget, formAge, formEmergency, formName, formPhone, refreshStudentPanel]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDelBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "deleteAcademyStudent");
      await fn({ academyId, studentId: deleteTarget.id });
      setNotice("학생을 삭제했습니다.");
      setDeleteTarget(null);
      refreshStudentPanel();
    } catch (e) {
      setNotice(fsErr(e));
    } finally {
      setDelBusy(false);
    }
  }, [academyId, deleteTarget, refreshStudentPanel]);

  const toggleTeacherForStudent = useCallback(
    async (student: StudentRowVM, teacherUid: string, add: boolean) => {
      const cur = student.assignedTeacherUids;
      let next: string[];
      if (add) {
        if (cur.includes(teacherUid)) return;
        if (cur.length >= MAX_ASSIGNED_TEACHERS_PER_STUDENT) {
          setNotice(
            `전담 선생님은 학생당 최대 ${MAX_ASSIGNED_TEACHERS_PER_STUDENT}명까지 지정할 수 있습니다.`,
          );
          return;
        }
        next = [...cur, teacherUid];
      } else {
        next = cur.filter((id) => id !== teacherUid);
      }
      setTeacherAssignBusyId(student.id);
      try {
        const db = getFirebaseDb();
        await updateDoc(doc(db, "academies", academyId, "students", student.id), {
          assignedTeacherUids: next,
          assignedTeacherUid: deleteField(),
          updatedAt: serverTimestamp(),
        });
        setNotice(
          next.length > 0 ? "전담 선생님을 저장했습니다." : "전담 선생님을 모두 해제했습니다.",
        );
        refreshStudentPanel();
      } catch (e) {
        setNotice(fsErr(e));
      } finally {
        setTeacherAssignBusyId(null);
      }
    },
    [academyId, refreshStudentPanel],
  );

  return (
    <div className="space-y-4">
      {notice ? (
        <p className="rounded-2xl bg-emerald-500/10 px-3 py-2 text-center text-xs text-emerald-900 ring-1 ring-emerald-500/20">
          {notice}
        </p>
      ) : null}
      {listError ? (
        <p className="rounded-2xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
          {listError}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">학생 관리</h2>
        <AcademyPanelRefreshButton busy={listBusy} onRefreshAction={refreshStudentPanel} />
      </div>

      <div className="flex gap-2">
        <input
          type="search"
          className="min-w-0 flex-1 rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-2.5 text-sm text-foreground shadow-inner outline-none placeholder:text-neutral-400 focus:border-[#4a90e2]/50 focus:bg-white/70"
          placeholder="이름·학부모·연락처·나이·학부모ID·전담선생으로 검색"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          aria-label="학생 검색"
        />
        <button
          type="button"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#222] dark:bg-neutral-100 text-white shadow-sm hover:bg-[#333] dark:hover:bg-white"
          aria-label="검색"
        >
          <SearchIcon />
        </button>
      </div>

      <div className="relative space-y-2 pb-8">
        {filtered.length === 0 ? (
          <p className={`py-10 text-center text-sm text-neutral-500 ${glassCard}`}>
            {students.length === 0 ? "등록된 학생이 없습니다." : "검색 결과가 없습니다."}
          </p>
        ) : (
          filtered.map((s) => {
            const modalOpen = teacherModalStudentId === s.id;
            return (
              <div
                key={s.id}
                className={`overflow-hidden ${glassCard} ${modalOpen ? "ring-1 ring-[#222]/10" : ""}`}
              >
                <div className="flex items-stretch gap-1 p-2 sm:gap-2 sm:p-3.5">
                  <button
                    type="button"
                    id={`student-row-${s.id}`}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl px-2 py-2 text-left transition hover:bg-white/35 active:bg-white/45 sm:gap-3 sm:px-3"
                    aria-haspopup="dialog"
                    aria-expanded={modalOpen}
                    aria-controls="student-assign-teachers-title"
                    onClick={() =>
                      setTeacherModalStudentId((prev) => (prev === s.id ? null : s.id))
                    }
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-foreground">{s.name}</span>
                      <span className="mt-0.5 block truncate text-xs text-neutral-500">
                        학부모 {s.parentName} · 만 {s.age}세
                      </span>
                      <span className="mt-0.5 block text-[11px] text-neutral-500">
                        연락 {formatKrPhoneDisplay(s.phone) || "—"} · 전담 선생{" "}
                        <span className="font-medium text-sky-900/90">
                          {s.assignedTeacherUids.length > 0
                            ? `${s.assignedTeacherUids.length}명`
                            : "없음"}
                        </span>
                      </span>
                      {s.tuitionDueDayOfMonth ? (
                        <span className="mt-0.5 block text-[11px] text-amber-800">
                          납부일 매월{" "}
                          <span className="font-medium">{s.tuitionDueDayOfMonth}일</span>
                          {s.tuitionAmount != null ? (
                            <> · {s.tuitionAmount.toLocaleString("ko-KR")}원</>
                          ) : null}
                        </span>
                      ) : s.weeklySessionCount != null ? (
                        <span className="mt-0.5 block text-[11px] text-violet-800">
                          회차 방식 · 주{s.weeklySessionCount}회
                          {s.pricePerSession != null ? (
                            <> · {s.pricePerSession.toLocaleString("ko-KR")}원/회</>
                          ) : null}
                          {s.sessionBalance != null ? (
                            <>
                              {" "}·{" "}
                              <span className={s.sessionBalance < 0 ? "font-medium text-red-700" : "font-medium"}>
                                잔여 {s.sessionBalance}회
                              </span>
                            </>
                          ) : null}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className="flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-sky-900/90"
                      aria-hidden
                    >
                      전담
                      <ChevronRightGlyph className="text-neutral-400" />
                    </span>
                  </button>
                  <div className="flex shrink-0 flex-col justify-center gap-1.5 sm:flex-row sm:items-center">
                    {s.weeklySessionCount != null ? (
                      <button
                        type="button"
                        className="rounded-xl border border-violet-300/70 bg-violet-50/70 px-3 py-2 text-[11px] font-medium text-violet-800 shadow-sm hover:bg-violet-100"
                        disabled={sessionCompleteBusy}
                        onClick={() => setSessionConfirmTarget(s)}
                      >
                        수업 완료
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="rounded-xl border border-neutral-300/70 bg-white/55 px-3 py-2 text-[11px] font-medium text-foreground shadow-sm hover:bg-white/90"
                      onClick={() => setTuitionModalTarget(s)}
                    >
                      원비
                    </button>
                    <button
                      type="button"
                      className="rounded-xl border border-neutral-300/70 bg-white/55 px-3 py-2 text-[11px] font-medium text-foreground shadow-sm hover:bg-white/90"
                      onClick={() => openEdit(s)}
                    >
                      수정
                    </button>
                    <button
                      type="button"
                      className="rounded-xl border border-neutral-300/70 bg-white/55 px-3 py-2 text-[11px] font-medium text-foreground shadow-sm hover:bg-white/90"
                      onClick={() => {
                        setTeacherModalStudentId(null);
                        setDeleteTarget(s);
                      }}
                    >
                      삭제
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <StudentAssignedTeachersModal
        academyId={academyId}
        student={teacherModalRow}
        onClose={closeTeacherModal}
        activeTeachersSorted={activeTeachersSorted}
        teacherNameById={teacherNameById}
        teacherAssignBusyId={teacherAssignBusyId}
        onToggleTeacher={toggleTeacherForStudent}
      />

      {editTarget ? (
        <EditStudentModal
          academyId={academyId}
          student={editTarget}
          open
          busy={editBusy}
          error={editErr}
          formName={formName}
          setFormName={setFormName}
          formAge={formAge}
          setFormAge={setFormAge}
          formPhone={formPhone}
          setFormPhone={setFormPhone}
          formEmergency={formEmergency}
          setFormEmergency={setFormEmergency}
          onClose={closeEdit}
          onSubmit={() => void saveEdit()}
        />
      ) : null}
      {deleteTarget ? (
        <DeleteStudentConfirmModal
          student={deleteTarget}
          busy={delBusy}
          onCancel={() => {
            if (!delBusy) setDeleteTarget(null);
          }}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
      {tuitionModalTarget ? (
        <TuitionSettingModal
          academyId={academyId}
          student={tuitionModalTarget}
          onClose={() => setTuitionModalTarget(null)}
          onSaved={() => {
            setNotice("원비 납부일을 저장했습니다.");
            refreshStudentPanel();
          }}
        />
      ) : null}
      {sessionConfirmTarget ? (
        <SessionCompleteConfirmModal
          student={sessionConfirmTarget}
          busy={sessionCompleteBusy}
          onCancel={() => { if (!sessionCompleteBusy) setSessionConfirmTarget(null); }}
          onConfirm={() => void recordSessionComplete(sessionConfirmTarget)}
        />
      ) : null}
    </div>
  );
}
