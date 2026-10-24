"use client";

import { FirebaseError } from "firebase/app";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { useCallback, useEffect, useState } from "react";
import {
  academyAbsenceDeductionSettingsPath,
  type AbsenceDeductionMethod,
  type AcademyAbsenceDeductionSettingsDoc,
} from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";
import { MAX_ABSENCE_DEDUCTION_PER_DAY } from "@/lib/payment/tuition-invoice";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

const METHODS: { value: AbsenceDeductionMethod; label: string; desc: string }[] = [
  {
    value: "divide",
    label: "원비 ÷ 월 수업일수",
    desc: "학생마다 원비가 달라도 자동으로 계산됩니다. 예: 원비 150,000원 ÷ 20일 = 1일 7,500원 (10원 미만 절사)",
  },
  {
    value: "per_day",
    label: "1일 고정 금액",
    desc: "모든 학생에게 같은 금액을 1일 차감액으로 제안합니다.",
  },
];

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={`shrink-0 text-neutral-400 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
    >
      <path
        d="M9 18l6-6-6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 결석 차감 기본값 — 청구 모달이 질병·학원 사정 결석 차감액을 제안할 때 사용.
 * 학생별 1일 차감액(청구 모달에서 저장)이 있으면 그 값이 우선.
 */
export function OwnerAbsenceDeductionSettingsCard({
  academyId,
  disabled,
  defaultCollapsed,
}: {
  academyId: string;
  disabled?: boolean;
  defaultCollapsed?: boolean;
}) {
  const [open, setOpen] = useState(!defaultCollapsed);
  const [method, setMethod] = useState<AbsenceDeductionMethod>("divide");
  const [classDays, setClassDays] = useState("");
  const [perDay, setPerDay] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snap = await getDoc(doc(getFirebaseDb(), academyAbsenceDeductionSettingsPath(academyId)));
        if (cancelled || !snap.exists()) return;
        const d = snap.data() as Partial<AcademyAbsenceDeductionSettingsDoc>;
        setMethod(d.method === "per_day" ? "per_day" : "divide");
        if (typeof d.monthlyClassDays === "number") setClassDays(String(d.monthlyClassDays));
        if (typeof d.perDayAmount === "number") setPerDay(String(d.perDayAmount));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyId]);

  const classDaysNum = Number(classDays);
  const perDayNum = Number(perDay);
  const valid =
    method === "divide"
      ? Number.isInteger(classDaysNum) && classDaysNum >= 1 && classDaysNum <= 31
      : Number.isInteger(perDayNum) && perDayNum > 0 && perDayNum <= MAX_ABSENCE_DEDUCTION_PER_DAY;

  const onSave = useCallback(async () => {
    if (!valid) return;
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      // 규칙이 필드를 제한하므로 merge 없이 덮어씀(선택하지 않은 방식의 값은 남기지 않음)
      await setDoc(doc(getFirebaseDb(), academyAbsenceDeductionSettingsPath(academyId)), {
        method,
        ...(method === "divide" ? { monthlyClassDays: classDaysNum } : { perDayAmount: perDayNum }),
        updatedAt: serverTimestamp(),
      });
      setSaved(true);
    } catch (e) {
      setError(e instanceof FirebaseError ? e.message : "저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }, [academyId, method, classDaysNum, perDayNum, valid]);

  const formDisabled = disabled || busy || !loaded;

  return (
    <section className="glass-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3.5 text-left"
      >
        <span className="text-sm font-semibold text-foreground">결석 차감 기본값</span>
        <ChevronIcon open={open} />
      </button>
      {open ? (
        <div className="border-t border-black/[0.06] px-4 pb-4 pt-3 dark:border-white/10 space-y-4">
          <p className="text-[11px] leading-relaxed text-neutral-600">
            질병·학원 사정 결석을 다음 청구서에서 차감할 때 제안할 1일 차감액 기준입니다. 차감은
            학생 청구 화면에서 확인한 뒤 반영되며, 학생별로 다른 금액을 저장할 수도 있습니다.
          </p>

          <div className="space-y-2">
            {METHODS.map(({ value, label, desc }) => (
              <label
                key={value}
                className={`flex cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 transition ${
                  method === value
                    ? "border-[#4a90e2]/60 bg-[#4a90e2]/[0.06] dark:bg-[#4a90e2]/[0.12]"
                    : "border-neutral-300/60 bg-white/40 dark:border-white/10 dark:bg-white/[0.04]"
                } ${formDisabled ? "pointer-events-none opacity-60" : ""}`}
              >
                <input
                  type="radio"
                  name={`absence-deduction-${academyId}`}
                  value={value}
                  checked={method === value}
                  onChange={() => {
                    setSaved(false);
                    setMethod(value);
                  }}
                  disabled={formDisabled}
                  className="mt-0.5 accent-[#4a90e2]"
                />
                <div>
                  <p className="text-sm font-medium text-foreground">{label}</p>
                  <p className="mt-0.5 text-[11px] text-neutral-500">{desc}</p>
                </div>
              </label>
            ))}
          </div>

          {method === "divide" ? (
            <div>
              <label
                className="mb-1 block text-xs font-medium text-neutral-600"
                htmlFor={`class-days-${academyId}`}
              >
                월 수업일수 (1~31일)
              </label>
              <input
                id={`class-days-${academyId}`}
                type="text"
                inputMode="numeric"
                value={classDays}
                onChange={(e) => {
                  setSaved(false);
                  setClassDays(e.target.value.replace(/[^\d]/g, "").slice(0, 2));
                }}
                placeholder="예: 20"
                className={inputClass}
                disabled={formDisabled}
              />
            </div>
          ) : (
            <div>
              <label
                className="mb-1 block text-xs font-medium text-neutral-600"
                htmlFor={`per-day-${academyId}`}
              >
                1일 차감액 (원)
              </label>
              <input
                id={`per-day-${academyId}`}
                type="text"
                inputMode="numeric"
                value={perDay ? Number(perDay).toLocaleString("ko-KR") : ""}
                onChange={(e) => {
                  setSaved(false);
                  setPerDay(e.target.value.replace(/[^\d]/g, "").slice(0, 8));
                }}
                placeholder="예: 7,500"
                className={inputClass}
                disabled={formDisabled}
              />
            </div>
          )}

          {error ? (
            <p className="text-sm text-red-700" role="alert">{error}</p>
          ) : null}
          {saved ? (
            <p className="text-sm text-emerald-800">결석 차감 기본값이 저장되었습니다.</p>
          ) : null}

          <button
            type="button"
            disabled={formDisabled || !valid}
            onClick={() => void onSave()}
            className="w-full rounded-2xl bg-[#222] py-2.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950 disabled:opacity-60"
          >
            {busy ? "저장 중…" : "저장"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
