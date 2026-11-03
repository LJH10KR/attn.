"use client";

import { FirebaseError } from "firebase/app";
import {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { academySessionTuitionSettingsPath, type TuitionType } from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

/**
 * 학원 기본 원비 납부 방식 — 원생 관리 상단 ⋯ 메뉴(예전 원생 패널에서 옮김, 2-E).
 * 권한: `operations.students`·`billing.invoices`(`meta/sessionTuitionSettings`·학생 원비 필드 규칙).
 */

const inputClass =
  "min-w-0 w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-2.5 text-sm text-foreground shadow-inner outline-none placeholder:text-neutral-400 focus:border-[#4a90e2]/50 focus:bg-white/70";

function fsErr(err: unknown): string {
  if (err instanceof FirebaseError) {
    return err.message || "요청에 실패했습니다.";
  }
  return "요청에 실패했습니다.";
}

export function DefaultTuitionTypeModal({
  academyId,
  onClose,
}: {
  academyId: string;
  onClose: () => void;
}) {
  const [type, setType] = useState<TuitionType>("monthly_fixed");
  const [dayInput, setDayInput] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [weeklyCountInput, setWeeklyCountInput] = useState("");
  const [priceInput, setPriceInput] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busyMode, setBusyMode] = useState<"save" | "applyAll" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const busy = busyMode !== null;
  useBodyScrollLock(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const db = getFirebaseDb();
        const snap = await getDoc(doc(db, academySessionTuitionSettingsPath(academyId)));
        if (cancelled) return;
        if (snap.exists()) {
          const d = snap.data();
          setType(d.defaultTuitionType === "session_based" ? "session_based" : "monthly_fixed");
          if (typeof d.defaultTuitionDueDayOfMonth === "number") setDayInput(String(d.defaultTuitionDueDayOfMonth));
          if (typeof d.defaultTuitionAmount === "number") setAmountInput(String(d.defaultTuitionAmount));
          if (typeof d.defaultWeeklySessionCount === "number") setWeeklyCountInput(String(d.defaultWeeklySessionCount));
          if (typeof d.defaultPricePerSession === "number") setPriceInput(String(d.defaultPricePerSession));
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const parseFields = ():
    | { ok: true; dayNum?: number; amountNum?: number; weeklyCount?: number; priceNum?: number }
    | { ok: false; error: string } => {
    if (type === "monthly_fixed") {
      const rawDay = dayInput.trim();
      let dayNum: number | undefined;
      if (rawDay) {
        dayNum = Number.parseInt(rawDay, 10);
        if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 31)
          return { ok: false, error: "납부 기준일은 1~31 사이의 정수로 입력해 주세요." };
      }
      const rawAmount = amountInput.trim();
      let amountNum: number | undefined;
      if (rawAmount) {
        amountNum = Number.parseInt(rawAmount.replace(/,/g, ""), 10);
        if (!Number.isFinite(amountNum) || amountNum < 0)
          return { ok: false, error: "금액이 올바르지 않습니다." };
      }
      return { ok: true, dayNum, amountNum };
    } else {
      const rawCount = weeklyCountInput.trim();
      let weeklyCount: number | undefined;
      if (rawCount) {
        weeklyCount = Number.parseInt(rawCount, 10);
        if (!Number.isInteger(weeklyCount) || weeklyCount < 1 || weeklyCount > 7)
          return { ok: false, error: "주간 수업 횟수는 1~7 사이로 입력해 주세요." };
      }
      const rawPrice = priceInput.trim();
      let priceNum: number | undefined;
      if (rawPrice) {
        priceNum = Number.parseInt(rawPrice.replace(/,/g, ""), 10);
        if (!Number.isFinite(priceNum) || priceNum < 0)
          return { ok: false, error: "금액이 올바르지 않습니다." };
      }
      return { ok: true, weeklyCount, priceNum };
    }
  };

  const execute = async (applyAll: boolean) => {
    setError(null);
    setSavedMsg(null);
    const result = parseFields();
    if (!result.ok) { setError(result.error); return; }

    if (applyAll) {
      if (type === "monthly_fixed" && result.dayNum == null) {
        setError("일괄 적용 시 납부 기준일을 입력해 주세요.");
        return;
      }
      if (type === "session_based" && result.weeklyCount == null) {
        setError("일괄 적용 시 주간 수업 횟수를 입력해 주세요.");
        return;
      }
    }

    setBusyMode(applyAll ? "applyAll" : "save");
    try {
      const db = getFirebaseDb();

      const settingsUpdate: Record<string, unknown> = {
        defaultTuitionType: type,
        updatedAt: serverTimestamp(),
      };
      if (type === "monthly_fixed") {
        if (result.dayNum != null) settingsUpdate.defaultTuitionDueDayOfMonth = result.dayNum;
        if (result.amountNum != null) settingsUpdate.defaultTuitionAmount = result.amountNum;
        settingsUpdate.defaultWeeklySessionCount = deleteField();
        settingsUpdate.defaultPricePerSession = deleteField();
      } else {
        if (result.weeklyCount != null) settingsUpdate.defaultWeeklySessionCount = result.weeklyCount;
        if (result.priceNum != null) settingsUpdate.defaultPricePerSession = result.priceNum;
        settingsUpdate.defaultTuitionDueDayOfMonth = deleteField();
        settingsUpdate.defaultTuitionAmount = deleteField();
      }
      await setDoc(doc(db, academySessionTuitionSettingsPath(academyId)), settingsUpdate, { merge: true });

      if (applyAll) {
        const studentsSnap = await getDocs(collection(db, "academies", academyId, "students"));
        const allDocs = studentsSnap.docs;
        for (let i = 0; i < allDocs.length; i += 499) {
          const batch = writeBatch(db);
          for (const studentDoc of allDocs.slice(i, i + 499)) {
            const studentRef = doc(db, "academies", academyId, "students", studentDoc.id);
            const updates: Record<string, unknown> = { tuitionType: deleteField(), updatedAt: serverTimestamp() };
            if (type === "monthly_fixed") {
              if (result.dayNum != null) updates.tuitionDueDayOfMonth = result.dayNum;
              if (result.amountNum != null) updates.tuitionAmount = result.amountNum;
              updates.weeklySessionCount = deleteField();
              updates.pricePerSession = deleteField();
              updates.sessionBalance = deleteField();
              updates.extraSessionDates = deleteField();
              updates.sentSessionPaymentReminder = deleteField();
              updates.tuitionReminderConfirmedAt = deleteField();
              updates.tuitionReminderConfirmedByUid = deleteField();
            } else {
              if (result.weeklyCount != null) updates.weeklySessionCount = result.weeklyCount;
              if (result.priceNum != null) updates.pricePerSession = result.priceNum;
              updates.tuitionDueDayOfMonth = deleteField();
              updates.tuitionAmount = deleteField();
            }
            batch.update(studentRef, updates);
          }
          await batch.commit();
        }
        setSavedMsg(`저장 완료 · ${allDocs.length}명 학생에게 일괄 적용되었습니다.`);
      } else {
        setSavedMsg("기본 납부 방식이 저장되었습니다.");
      }
    } catch (e) {
      setError(fsErr(e));
    } finally {
      setBusyMode(null);
    }
  };

  const formDisabled = !loaded || busy;

  const radioClass = (active: boolean) =>
    `flex cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 transition ${
      active
        ? "border-[#4a90e2]/60 bg-[#4a90e2]/[0.06] dark:bg-[#4a90e2]/[0.12]"
        : "border-neutral-300/60 bg-white/40 dark:border-white/10 dark:bg-white/[0.04]"
    } ${formDisabled ? "pointer-events-none opacity-60" : ""}`;

  return createPortal(
    <div
      className="fixed inset-0 z-[999] flex items-end justify-center bg-black/50 sm:items-center"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="w-full max-w-sm rounded-t-3xl sm:rounded-3xl bg-background shadow-xl">
        <div className="max-h-[min(90dvh,640px)] overflow-y-auto p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-foreground">기본 원비 납부 방식</h3>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-full p-1 text-neutral-400 hover:text-neutral-700 disabled:opacity-50"
              aria-label="닫기"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <p className="text-[11px] leading-relaxed text-neutral-500">
            학생 개별 원비 설정에서 방식을 지정하지 않으면 이 기본값이 사용됩니다.
          </p>

          {/* 매월 지정일 */}
          <label className={radioClass(type === "monthly_fixed")}>
            <input
              type="radio" name="default-tuition-type" value="monthly_fixed"
              checked={type === "monthly_fixed"}
              onChange={() => { setSavedMsg(null); setType("monthly_fixed"); }}
              disabled={formDisabled}
              className="mt-0.5 accent-[#4a90e2]"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">매월 지정일 납부</p>
              <p className="mt-0.5 text-[11px] text-neutral-500">매월 특정 날짜에 고정 금액을 납부합니다.</p>
            </div>
          </label>

          {type === "monthly_fixed" ? (
            <div className="space-y-2 px-1">
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600">납부 기준일 (매월)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={1} max={31} step={1} placeholder="예: 25"
                    className={inputClass}
                    value={dayInput}
                    onChange={(e) => { setSavedMsg(null); setDayInput(e.target.value); }}
                    disabled={formDisabled}
                  />
                  <span className="shrink-0 text-sm text-neutral-600">일</span>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600">기본 금액 (원, 선택)</label>
                <input
                  type="number" min={0} step={1000} placeholder="예: 300000"
                  className={inputClass}
                  value={amountInput}
                  onChange={(e) => { setSavedMsg(null); setAmountInput(e.target.value); }}
                  disabled={formDisabled}
                />
              </div>
            </div>
          ) : null}

          {/* 회차 방식 */}
          <label className={radioClass(type === "session_based")}>
            <input
              type="radio" name="default-tuition-type" value="session_based"
              checked={type === "session_based"}
              onChange={() => { setSavedMsg(null); setType("session_based"); }}
              disabled={formDisabled}
              className="mt-0.5 accent-[#4a90e2]"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">회차 방식 납부</p>
              <p className="mt-0.5 text-[11px] text-neutral-500">4주(1달) 분 수업료 기준으로 잔여 횟수가 1주분 이하가 되면 납부 안내를 발송합니다.</p>
            </div>
          </label>

          {type === "session_based" ? (
            <div className="space-y-2 px-1">
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600">기본 주간 수업 횟수</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={1} max={7} step={1} placeholder="예: 2"
                    className={inputClass}
                    value={weeklyCountInput}
                    onChange={(e) => { setSavedMsg(null); setWeeklyCountInput(e.target.value); }}
                    disabled={formDisabled}
                  />
                  <span className="shrink-0 text-sm text-neutral-600">회/주</span>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600">기본 회당 금액 (원, 선택)</label>
                <input
                  type="number" min={0} step={1000} placeholder="예: 50000"
                  className={inputClass}
                  value={priceInput}
                  onChange={(e) => { setSavedMsg(null); setPriceInput(e.target.value); }}
                  disabled={formDisabled}
                />
              </div>
            </div>
          ) : null}

          {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
          {savedMsg ? <p className="text-sm text-emerald-800">{savedMsg}</p> : null}

          <div className="flex gap-2 pt-1">
            <button
              type="button" onClick={onClose} disabled={busy}
              className="flex-1 rounded-2xl border border-neutral-300/70 bg-white/50 py-2.5 text-sm font-medium text-foreground disabled:opacity-60"
            >
              닫기
            </button>
            <button
              type="button" onClick={() => void execute(false)} disabled={formDisabled}
              className="flex-1 rounded-2xl bg-[#222] dark:bg-neutral-100 py-2.5 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-60"
            >
              {busyMode === "save" ? "저장 중…" : "저장"}
            </button>
          </div>

          <div className="space-y-1.5">
            <p className="text-center text-[11px] text-neutral-500">
              일괄 적용 시 모든 학생의 원비 설정이 위 값으로 덮어씌워집니다.
            </p>
            <button
              type="button" onClick={() => void execute(true)} disabled={formDisabled}
              className="w-full rounded-2xl border border-amber-300/70 bg-amber-50/80 py-2.5 text-sm font-medium text-amber-900 hover:bg-amber-100/80 disabled:opacity-60"
            >
              {busyMode === "applyAll" ? "적용 중…" : "저장 + 일괄 적용"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
