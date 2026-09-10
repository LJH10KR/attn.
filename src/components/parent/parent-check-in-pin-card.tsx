"use client";

import { httpsCallable } from "firebase/functions";
import { useCallback, useState } from "react";
import { PinPadModal } from "@/components/academy/pin-pad-modal";
import type { StudentRowVM } from "@/components/academy/academy-student-panel";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { FirebaseError } from "firebase/app";

const glassCard = "glass-card";

function callableMessage(err: unknown, fallback: string): string {
  if (err instanceof FirebaseError && err.message) return err.message;
  return fallback;
}

type Props = {
  academyId: string;
  student: StudentRowVM & { hasCheckInPin?: boolean };
  onUpdatedAction?: () => void;
};

export function ParentCheckInPinCard({ academyId, student, onUpdatedAction }: Props) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"current" | "new" | "confirm">(
    student.hasCheckInPin ? "current" : "new",
  );
  const [pendingNew, setPendingNew] = useState<string | null>(null);
  const [currentPin, setCurrentPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const resetFlow = useCallback(() => {
    setStep(student.hasCheckInPin ? "current" : "new");
    setPendingNew(null);
    setCurrentPin("");
    setError(null);
  }, [student.hasCheckInPin]);

  const savePin = useCallback(
    async (newPin: string, cur?: string) => {
      setBusy(true);
      setError(null);
      try {
        const fn = httpsCallable(getFirebaseFunctions(), "setStudentCheckInPin");
        await fn({
          academyId,
          studentId: student.id,
          newPin,
          ...(cur ? { currentPin: cur } : {}),
        });
        setToast(`${student.name} 학생의 출석 PIN이 저장되었습니다.`);
        setOpen(false);
        resetFlow();
        onUpdatedAction?.();
      } catch (err) {
        setError(callableMessage(err, "PIN 저장에 실패했습니다."));
      } finally {
        setBusy(false);
      }
    },
    [academyId, student.id, student.name, onUpdatedAction, resetFlow],
  );

  return (
    <div className={`mt-2 p-3 ${glassCard}`}>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        출석 키오스크에서 사용할 PIN입니다.
        {student.hasCheckInPin ? " (설정됨)" : " (미설정)"}
      </p>
      {toast ? (
        <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">{toast}</p>
      ) : null}
      <button
        type="button"
        className="mt-2 rounded-[8px] border border-neutral-200 px-3 py-2 text-xs font-medium dark:border-white/15"
        onClick={() => {
          resetFlow();
          setOpen(true);
        }}
      >
        {student.hasCheckInPin ? "출석 PIN 변경" : "출석 PIN 설정"}
      </button>

      <PinPadModal
        open={open}
        phaseKey={open ? step : "closed"}
        title={
          step === "current"
            ? "기존 출석 PIN"
            : step === "new"
              ? "새 출석 PIN"
              : "새 출석 PIN 확인"
        }
        description={`${student.name} 학생`}
        error={error}
        busy={busy}
        busyTitle="출석 PIN 저장 중..."
        busyDescription="잠시만 기다려 주세요."
        onCloseAction={() => {
          if (!busy) {
            setOpen(false);
            resetFlow();
          }
        }}
        onCompleteAction={(pin) => {
          if (step === "current") {
            setCurrentPin(pin);
            setStep("new");
            return;
          }
          if (step === "new") {
            setPendingNew(pin);
            setStep("confirm");
            return;
          }
          if (pin !== pendingNew) {
            setError("PIN이 일치하지 않습니다.");
            setStep("new");
            setPendingNew(null);
            return;
          }
          void savePin(pin, student.hasCheckInPin ? currentPin : undefined);
        }}
      />
    </div>
  );
}
