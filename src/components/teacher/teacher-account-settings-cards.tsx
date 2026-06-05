"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useRef, useState } from "react";
import { MemberPasswordSettingsCard } from "@/components/account/password-settings-cards";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import {
  getMemberLoginIdFormatError,
  normalizeMemberLoginId,
} from "@/lib/member-login-id";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

function InlineSpinner() {
  return (
    <span
      className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-neutral-200 border-t-[#222] dark:border-white/20 dark:border-t-white"
      aria-hidden
    />
  );
}

export function TeacherLoginIdSettingsCard({
  attnId,
  currentLoginId,
  disabled,
  onSavedAction,
}: {
  attnId: string;
  currentLoginId: string;
  disabled?: boolean;
  onSavedAction?: (loginId: string) => void;
}) {
  const [newLoginId, setNewLoginId] = useState(currentLoginId);
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
    setNewLoginId(currentLoginId);
  }, [currentLoginId]);

  const runAvailabilityCheck = useCallback(
    async (id: string) => {
      const fmtErr = getMemberLoginIdFormatError(id);
      if (fmtErr) {
        setCheckStatus("invalid");
        setCheckMessage(fmtErr);
        return;
      }
      const normalized = normalizeMemberLoginId(id);
      if (normalized === currentLoginId) {
        setCheckStatus("available");
        setCheckMessage("현재와 동일한 로그인 ID입니다.");
        return;
      }
      const gen = ++checkGen.current;
      setCheckStatus("checking");
      setCheckMessage(null);
      try {
        const fn = httpsCallable(getFirebaseFunctions(), "checkTeacherLoginIdAvailable");
        await fn({ loginId: normalized });
        if (gen !== checkGen.current) return;
        setCheckStatus("available");
        setCheckMessage("사용할 수 있는 로그인 ID입니다.");
      } catch (e) {
        if (gen !== checkGen.current) return;
        if (e instanceof FirebaseError && e.code === "functions/already-exists") {
          setCheckStatus("taken");
          setCheckMessage(e.message || "이미 사용 중인 로그인 ID입니다.");
          return;
        }
        setCheckStatus("invalid");
        setCheckMessage(
          e instanceof FirebaseError ? e.message : "확인에 실패했습니다.",
        );
      }
    },
    [currentLoginId],
  );

  const onSave = useCallback(async () => {
    setError(null);
    setSaved(false);
    const normalized = normalizeMemberLoginId(newLoginId);
    const fmtErr = getMemberLoginIdFormatError(newLoginId);
    if (fmtErr) {
      setError(fmtErr);
      return;
    }
    if (!currentPassword) {
      setError("현재 비밀번호를 입력해 주세요.");
      return;
    }
    if (normalized !== currentLoginId && checkStatus !== "available") {
      setError("로그인 ID 중복 확인을 완료해 주세요.");
      return;
    }
    setBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "updateTeacherLoginId");
      await fn({ loginId: normalized, currentPassword });
      setSaved(true);
      setCurrentPassword("");
      onSavedAction?.(normalized);
    } catch (e) {
      setError(e instanceof FirebaseError ? e.message : "저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }, [
    checkStatus,
    currentLoginId,
    currentPassword,
    newLoginId,
    onSavedAction,
  ]);

  const formDisabled = disabled || busy;

  return (
    <section className="glass-card space-y-4 p-4">
      <h2 className="text-sm font-semibold text-foreground">로그인 ID</h2>
      <p className="text-[11px] leading-relaxed text-neutral-600">
        로그인에 쓰는 별칭입니다. 한글 4~12자 또는 영문·숫자·밑줄(_) 조합이며 전역에서
        유일해야 합니다. 관리 번호(attn)와는 별개입니다.
      </p>
      {attnId ? (
        <div>
          <p className="text-xs font-medium text-neutral-500">관리 번호 (attn)</p>
          <p className="mt-1 font-mono text-sm text-foreground">{attnId}</p>
        </div>
      ) : null}
      <div>
        <p className="text-xs font-medium text-neutral-500">현재 로그인 ID</p>
        {currentLoginId ? (
          <p className="mt-1 font-mono text-sm text-foreground">{currentLoginId}</p>
        ) : (
          <p className="mt-1 text-sm text-neutral-600">
            아직 설정되지 않았습니다. 아래에서 설정하면 관리 번호 대신 이 ID로 로그인할 수
            있습니다.
          </p>
        )}
      </div>
      <div>
        <label
          className="mb-1 block text-xs font-medium text-neutral-600"
          htmlFor="t-new-login-id"
        >
          {currentLoginId ? "새 로그인 ID" : "로그인 ID 설정"}
        </label>
        <input
          id="t-new-login-id"
          className={inputClass}
          value={newLoginId}
          onChange={(e) => {
            setNewLoginId(e.target.value);
            setCheckStatus("idle");
            setCheckMessage(null);
            setSaved(false);
          }}
          onBlur={() => {
            if (newLoginId.trim()) void runAvailabilityCheck(newLoginId);
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
          htmlFor="t-login-id-pw"
        >
          현재 비밀번호 <span className="text-red-600">*</span>
        </label>
        <input
          id="t-login-id-pw"
          type="password"
          autoComplete="current-password"
          className={inputClass}
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          disabled={formDisabled}
        />
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {saved ? <p className="text-sm text-emerald-800">로그인 ID가 저장되었습니다.</p> : null}
      <button
        type="button"
        disabled={formDisabled}
        onClick={() => void onSave()}
        className="w-full rounded-2xl border border-neutral-300/70 bg-white/70 py-2.5 text-sm font-medium text-foreground disabled:opacity-60 dark:border-white/12 dark:bg-white/10"
      >
        {busy ? "저장 중…" : "로그인 ID 저장"}
      </button>
    </section>
  );
}

export function TeacherPasswordSettingsCard({ disabled }: { disabled?: boolean }) {
  return (
    <MemberPasswordSettingsCard
      callableName="updateTeacherPassword"
      idPrefix="teacher"
      description="로그인 ID와 함께 쓰는 비밀번호를 변경합니다. Google 연결 시 본인 확인에도 사용됩니다."
      disabled={disabled}
    />
  );
}
