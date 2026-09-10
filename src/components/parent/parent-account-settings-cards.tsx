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

export function ParentLoginIdSettingsCard({
  attnId,
  currentLoginId,
  requirePassword,
  disabled,
  onSavedAction,
  defaultCollapsed,
}: {
  attnId: string;
  currentLoginId: string;
  /** false면 Google 전용 등 — 비밀번호 없이 변경 */
  requirePassword: boolean;
  disabled?: boolean;
  onSavedAction?: (loginId: string) => void;
  defaultCollapsed?: boolean;
}) {
  const [open, setOpen] = useState(!defaultCollapsed);
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
        const fn = httpsCallable(getFirebaseFunctions(), "checkParentLoginIdForUpdate");
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
    if (requirePassword && !currentPassword) {
      setError("현재 비밀번호를 입력해 주세요.");
      return;
    }
    if (normalized !== currentLoginId && checkStatus !== "available") {
      setError("로그인 ID 중복 확인을 완료해 주세요.");
      return;
    }
    setBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "updateParentLoginId");
      await fn({
        loginId: normalized,
        ...(requirePassword ? { currentPassword } : {}),
      });
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
    requirePassword,
  ]);

  const formDisabled = disabled || busy;
  const isEmailLoginId = currentLoginId.includes("@");

  return (
    <section className="glass-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3.5 text-left"
      >
        <span className="text-sm font-semibold text-foreground">로그인 ID</span>
        <ChevronIcon open={open} />
      </button>
      {open ? (
        <div className="border-t border-black/[0.06] px-4 pb-4 pt-3 dark:border-white/10 space-y-4">
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
              <p className="mt-1 break-all font-mono text-sm text-foreground">{currentLoginId}</p>
            ) : (
              <p className="mt-1 text-sm text-neutral-600">아직 설정되지 않았습니다.</p>
            )}
            {isEmailLoginId ? (
              <p className="mt-2 text-[11px] text-neutral-500">
                Google 가입 시 Gmail이 로그인 ID로 쓰였습니다. 아래에서 별칭으로 바꿀 수
                있습니다.
              </p>
            ) : null}
          </div>
          <div>
            <label
              className="mb-1 block text-xs font-medium text-neutral-600"
              htmlFor="p-new-login-id"
            >
              {currentLoginId && !isEmailLoginId ? "새 로그인 ID" : "로그인 ID 설정"}
            </label>
            <input
              id="p-new-login-id"
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
          {requirePassword ? (
            <div>
              <label
                className="mb-1 block text-xs font-medium text-neutral-600"
                htmlFor="p-login-id-pw"
              >
                현재 비밀번호 <span className="text-red-600">*</span>
              </label>
              <input
                id="p-login-id-pw"
                type="password"
                autoComplete="current-password"
                className={inputClass}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                disabled={formDisabled}
              />
            </div>
          ) : null}
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
        </div>
      ) : null}
    </section>
  );
}

export function ParentPasswordSettingsCard({
  disabled,
  registerMode,
  defaultCollapsed,
  onSavedAction,
}: {
  disabled?: boolean;
  registerMode?: boolean;
  defaultCollapsed?: boolean;
  onSavedAction?: () => void;
}) {
  return (
    <MemberPasswordSettingsCard
      callableName="updateParentPassword"
      idPrefix="parent"
      description={
        registerMode
          ? "Google 로그인과 함께 로그인 ID·비밀번호로도 로그인할 수 있도록 비밀번호를 등록합니다."
          : "로그인 ID와 함께 쓰는 비밀번호를 변경합니다. Google 연결 시 본인 확인에도 사용됩니다."
      }
      disabled={disabled}
      registerMode={registerMode}
      defaultCollapsed={defaultCollapsed}
      onSavedAction={onSavedAction}
    />
  );
}
