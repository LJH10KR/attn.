"use client";

import { FirebaseError } from "firebase/app";
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { useCallback, useEffect, useState } from "react";
import {
  academySessionTuitionSettingsPath,
  type AcademySessionTuitionSettingsDoc,
  type TuitionType,
} from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";

const TYPES: { value: TuitionType; label: string; desc: string }[] = [
  {
    value: "monthly_fixed",
    label: "매월 지정일 납부",
    desc: "매월 특정 날짜에 고정 금액을 납부합니다.",
  },
  {
    value: "session_based",
    label: "회차 방식 납부",
    desc: "주당 수업 횟수 기준으로 잔여 횟수가 기준치 이하가 되면 납부 안내를 발송합니다.",
  },
];

export function OwnerSessionTuitionSettingsCard({
  academyId,
  academyName,
  disabled,
}: {
  academyId: string;
  academyName: string;
  disabled?: boolean;
}) {
  const [defaultType, setDefaultType] = useState<TuitionType>("monthly_fixed");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const db = getFirebaseDb();
    const ref = doc(db, academySessionTuitionSettingsPath(academyId));
    return onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const d = snap.data() as AcademySessionTuitionSettingsDoc;
          setDefaultType(d.defaultTuitionType === "session_based" ? "session_based" : "monthly_fixed");
        }
        setLoaded(true);
      },
      () => setLoaded(true),
    );
  }, [academyId]);

  const onSave = useCallback(async () => {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const db = getFirebaseDb();
      await setDoc(
        doc(db, academySessionTuitionSettingsPath(academyId)),
        { defaultTuitionType: defaultType, updatedAt: serverTimestamp() },
        { merge: true },
      );
      setSaved(true);
    } catch (e) {
      setError(e instanceof FirebaseError ? e.message : "저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }, [academyId, defaultType]);

  const formDisabled = disabled || busy || !loaded;

  return (
    <section className="glass-card space-y-4 p-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">원비 납부 방식 기본값</h2>
        {academyName ? (
          <p className="mt-0.5 text-[11px] text-neutral-500">{academyName}</p>
        ) : null}
      </div>
      <p className="text-[11px] leading-relaxed text-neutral-600">
        학원의 기본 원비 납부 방식을 설정합니다. 학생 원비 설정에서 학생별로 개별 방식을 지정하면 이 설정보다 우선합니다.
      </p>

      <div className="space-y-2">
        {TYPES.map(({ value, label, desc }) => (
          <label
            key={value}
            className={`flex cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 transition ${
              defaultType === value
                ? "border-[#4a90e2]/60 bg-[#4a90e2]/[0.06] dark:bg-[#4a90e2]/[0.12]"
                : "border-neutral-300/60 bg-white/40 dark:border-white/10 dark:bg-white/[0.04]"
            } ${formDisabled ? "pointer-events-none opacity-60" : ""}`}
          >
            <input
              type="radio"
              name={`tuition-type-${academyId}`}
              value={value}
              checked={defaultType === value}
              onChange={() => {
                setSaved(false);
                setDefaultType(value);
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

      {error ? (
        <p className="text-sm text-red-700" role="alert">{error}</p>
      ) : null}
      {saved ? (
        <p className="text-sm text-emerald-800">납부 방식 기본값이 저장되었습니다.</p>
      ) : null}

      <button
        type="button"
        disabled={formDisabled}
        onClick={() => void onSave()}
        className="w-full rounded-2xl bg-[#222] py-2.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950 disabled:opacity-60"
      >
        {busy ? "저장 중…" : "저장"}
      </button>
    </section>
  );
}
