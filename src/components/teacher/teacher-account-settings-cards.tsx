"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useRef, useState } from "react";
import { PasswordInput } from "@/components/ui/password-input";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { resolvePasswordConfirmHint } from "@/lib/ui/password-confirm-hint";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

const TEACHER_ATTN_ID_RE = /^\d{5}_\d{2}_\d{3}$/;

function InlineSpinner() {
  return (
    <span
      className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-neutral-200 border-t-[#222] dark:border-white/20 dark:border-t-white"
      aria-hidden
    />
  );
}

export function TeacherAttnIdSettingsCard({
  academyId,
  currentAttnId,
  disabled,
  onSavedAction,
}: {
  academyId: string;
  currentAttnId: string;
  disabled?: boolean;
  onSavedAction?: (attnId: string) => void;
}) {
  const [newAttnId, setNewAttnId] = useState(currentAttnId);
  const [currentPassword, setCurrentPassword] = useState("");
  const [checkStatus, setCheckStatus] = useState<
    "idle" | "checking" | "available" | "taken" | "invalid"
  >("idle");
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const checkGen = useRef(0);

  useEffect(() => {
    setNewAttnId(currentAttnId);
  }, [currentAttnId]);

  const validateFormat = useCallback(
    (id: string): string | null => {
      const trimmed = id.trim();
      if (!trimmed) return "로그인 번호를 입력해 주세요.";
      if (!TEACHER_ATTN_ID_RE.test(trimmed)) {
        return "형식: 00001_01_001 (학원 번호_선생님 순번)";
      }
      if (!trimmed.startsWith(`${academyId}_`)) {
        return `이 학원(${academyId})에 속한 번호만 사용할 수 있습니다.`;
      }
      return null;
    },
    [academyId],
  );

  const runAvailabilityCheck = useCallback(
    async (id: string) => {
      const fmtErr = validateFormat(id);
      if (fmtErr) {
        setCheckStatus("invalid");
        setCheckMessage(fmtErr);
        return;
      }
      if (id.trim() === currentAttnId) {
        setCheckStatus("available");
        setCheckMessage("현재와 동일한 로그인 번호입니다.");
        return;
      }
      const gen = ++checkGen.current;
      setCheckStatus("checking");
      setCheckMessage(null);
      try {
        const fn = httpsCallable(getFirebaseFunctions(), "checkTeacherAttnIdAvailable");
        await fn({ attnId: id.trim() });
        if (gen !== checkGen.current) return;
        setCheckStatus("available");
        setCheckMessage("사용할 수 있는 로그인 번호입니다.");
      } catch (e) {
        if (gen !== checkGen.current) return;
        if (e instanceof FirebaseError && e.code === "functions/already-exists") {
          setCheckStatus("taken");
          setCheckMessage(e.message || "이미 사용 중인 로그인 번호입니다.");
          return;
        }
        setCheckStatus("invalid");
        setCheckMessage(
          e instanceof FirebaseError ? e.message : "확인에 실패했습니다.",
        );
      }
    },
    [currentAttnId, validateFormat],
  );

  const onSave = useCallback(async () => {
    setError(null);
    setSaved(false);
    const trimmed = newAttnId.trim();
    const fmtErr = validateFormat(trimmed);
    if (fmtErr) {
      setError(fmtErr);
      return;
    }
    if (!currentPassword) {
      setError("현재 비밀번호를 입력해 주세요.");
      return;
    }
    if (trimmed !== currentAttnId && checkStatus !== "available") {
      setError("로그인 번호 중복 확인을 완료해 주세요.");
      return;
    }
    setBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "updateTeacherAttnId");
      await fn({ attnId: trimmed, currentPassword });
      setSaved(true);
      setCurrentPassword("");
      onSavedAction?.(trimmed);
    } catch (e) {
      setError(e instanceof FirebaseError ? e.message : "저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }, [
    checkStatus,
    currentAttnId,
    currentPassword,
    newAttnId,
    onSavedAction,
    validateFormat,
  ]);

  const formDisabled = disabled || busy;

  return (
    <section className="glass-card space-y-4 p-4">
      <h2 className="text-sm font-semibold text-foreground">로그인 번호 변경</h2>
      <p className="text-[11px] leading-relaxed text-neutral-600">
        attn. 로그인에 쓰는 번호입니다. 같은 학원(
        <span className="font-mono">{academyId}</span>) 형식만 변경할 수 있습니다.
      </p>
      <div>
        <p className="text-xs font-medium text-neutral-500">현재 로그인 번호</p>
        <p className="mt-1 font-mono text-sm text-foreground">
          {currentAttnId || "—"}
        </p>
      </div>
      <div>
        <label
          className="mb-1 block text-xs font-medium text-neutral-600"
          htmlFor="t-new-attn"
        >
          새 로그인 번호
        </label>
        <input
          id="t-new-attn"
          className={`${inputClass} font-mono`}
          value={newAttnId}
          onChange={(e) => {
            setNewAttnId(e.target.value);
            setCheckStatus("idle");
            setCheckMessage(null);
            setSaved(false);
          }}
          onBlur={() => {
            if (newAttnId.trim()) void runAvailabilityCheck(newAttnId);
          }}
          disabled={formDisabled}
          autoComplete="off"
          spellCheck={false}
        />
        {checkStatus === "checking" ? (
          <p className="mt-2 flex items-center gap-2 text-xs text-neutral-500">
            <InlineSpinner />
            중복 확인 중…
          </p>
        ) : checkMessage ? (
          <p
            className={`mt-2 text-xs ${
              checkStatus === "available"
                ? "text-emerald-800"
                : checkStatus === "taken"
                  ? "text-red-700"
                  : "text-neutral-600"
            }`}
          >
            {checkMessage}
          </p>
        ) : null}
      </div>
      <div>
        <label
          className="mb-1 block text-xs font-medium text-neutral-600"
          htmlFor="t-attn-pw"
        >
          현재 비밀번호 <span className="text-red-600">*</span>
        </label>
        <input
          id="t-attn-pw"
          type="password"
          autoComplete="current-password"
          className={inputClass}
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          disabled={formDisabled}
        />
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {saved ? <p className="text-sm text-emerald-800">로그인 번호가 변경되었습니다.</p> : null}
      <button
        type="button"
        disabled={formDisabled}
        onClick={() => void onSave()}
        className="w-full rounded-2xl border border-neutral-300/70 bg-white/70 py-2.5 text-sm font-medium text-foreground disabled:opacity-60 dark:border-white/12 dark:bg-white/10"
      >
        {busy ? "저장 중…" : "로그인 번호 저장"}
      </button>
    </section>
  );
}

export function TeacherPasswordSettingsCard({ disabled }: { disabled?: boolean }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPassword2, setNewPassword2] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showNew2, setShowNew2] = useState(false);
  const [confirmBlurred, setConfirmBlurred] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const passwordConfirmHint = resolvePasswordConfirmHint(
    newPassword,
    newPassword2,
    confirmBlurred,
  );

  const onSave = useCallback(async () => {
    setError(null);
    setSaved(false);
    if (!currentPassword) {
      setError("현재 비밀번호를 입력해 주세요.");
      return;
    }
    if (newPassword.length < 6) {
      setError("새 비밀번호는 6자 이상이어야 합니다.");
      return;
    }
    if (newPassword !== newPassword2) {
      setError("새 비밀번호가 서로 일치하지 않습니다.");
      return;
    }
    if (currentPassword === newPassword) {
      setError("새 비밀번호는 현재 비밀번호와 달라야 합니다.");
      return;
    }
    setBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "updateTeacherPassword");
      await fn({ currentPassword, newPassword });
      setSaved(true);
      setCurrentPassword("");
      setNewPassword("");
      setNewPassword2("");
      setConfirmBlurred(false);
    } catch (e) {
      setError(e instanceof FirebaseError ? e.message : "변경에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }, [currentPassword, newPassword, newPassword2]);

  const formDisabled = disabled || busy;

  return (
    <section className="glass-card space-y-4 p-4">
      <h2 className="text-sm font-semibold text-foreground">비밀번호 변경</h2>
      <p className="text-[11px] leading-relaxed text-neutral-600">
        로그인 번호와 함께 쓰는 비밀번호를 변경합니다. Google 연결 시 본인 확인에도
        사용됩니다.
      </p>
      <PasswordInput
        id="t-cur-pw"
        label={
          <>
            현재 비밀번호 <span className="text-red-600">*</span>
          </>
        }
        value={currentPassword}
        onChangeAction={setCurrentPassword}
        visible={showCurrent}
        onToggleVisibleAction={() => setShowCurrent((v) => !v)}
        inputClassName={inputClass}
        labelClassName="mb-1 block text-xs font-medium text-neutral-600"
        disabled={formDisabled}
        autoComplete="current-password"
      />
      <PasswordInput
        id="t-new-pw"
        label={
          <>
            새 비밀번호 <span className="text-red-600">*</span>
          </>
        }
        value={newPassword}
        onChangeAction={setNewPassword}
        visible={showNew}
        onToggleVisibleAction={() => setShowNew((v) => !v)}
        inputClassName={inputClass}
        labelClassName="mb-1 block text-xs font-medium text-neutral-600"
        disabled={formDisabled}
        minLength={6}
        autoComplete="new-password"
      />
      <PasswordInput
        id="t-new-pw2"
        label={
          <>
            새 비밀번호 확인 <span className="text-red-600">*</span>
          </>
        }
        value={newPassword2}
        onChangeAction={setNewPassword2}
        onBlurAction={() => setConfirmBlurred(true)}
        visible={showNew2}
        onToggleVisibleAction={() => setShowNew2((v) => !v)}
        confirmHint={passwordConfirmHint}
        inputClassName={inputClass}
        labelClassName="mb-1 block text-xs font-medium text-neutral-600"
        disabled={formDisabled}
        minLength={6}
        autoComplete="new-password"
      />
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {saved ? <p className="text-sm text-emerald-800">비밀번호가 변경되었습니다.</p> : null}
      <button
        type="button"
        disabled={formDisabled}
        onClick={() => void onSave()}
        className="w-full rounded-2xl bg-[#222] py-2.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950 disabled:opacity-60"
      >
        {busy ? "변경 중…" : "비밀번호 저장"}
      </button>
    </section>
  );
}
