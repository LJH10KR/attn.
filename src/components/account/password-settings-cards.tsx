"use client";

import { FirebaseError } from "firebase/app";
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  linkWithCredential,
  onAuthStateChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  updatePassword,
  type User,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PasswordInput } from "@/components/ui/password-input";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { resolvePasswordConfirmHint } from "@/lib/ui/password-confirm-hint";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

function hasPasswordProvider(user: User): boolean {
  return user.providerData.some((p) => p.providerId === "password");
}

export type MemberPasswordSettingsCardProps = {
  callableName: string;
  description: string;
  idPrefix: string;
  disabled?: boolean;
  minLength?: number;
  /** Google 전용 등 — 비밀번호 최초 등록 */
  registerMode?: boolean;
};

/** 선생님·학부모 — Callable로 비밀번호 변경 */
export function MemberPasswordSettingsCard({
  callableName,
  description,
  idPrefix,
  disabled,
  minLength = 6,
  registerMode = false,
}: MemberPasswordSettingsCardProps) {
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
    if (!registerMode && !currentPassword) {
      setError("현재 비밀번호를 입력해 주세요.");
      return;
    }
    if (newPassword.length < minLength) {
      setError(`새 비밀번호는 ${minLength}자 이상이어야 합니다.`);
      return;
    }
    if (newPassword !== newPassword2) {
      setError("새 비밀번호가 서로 일치하지 않습니다.");
      return;
    }
    if (!registerMode && currentPassword === newPassword) {
      setError("새 비밀번호는 현재 비밀번호와 달라야 합니다.");
      return;
    }
    setBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), callableName);
      if (registerMode) {
        await fn({ newPassword, register: true });
      } else {
        await fn({ currentPassword, newPassword });
      }
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
  }, [callableName, currentPassword, minLength, newPassword, newPassword2, registerMode]);

  const formDisabled = disabled || busy;

  return (
    <section className="glass-card space-y-4 p-4">
      <h2 className="text-sm font-semibold text-foreground">
        {registerMode ? "비밀번호 등록" : "비밀번호 변경"}
      </h2>
      <p className="text-[11px] leading-relaxed text-neutral-600">{description}</p>
      {!registerMode ? (
        <PasswordInput
          id={`${idPrefix}-cur-pw`}
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
      ) : null}
      <PasswordInput
        id={`${idPrefix}-new-pw`}
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
        minLength={minLength}
        autoComplete="new-password"
      />
      <PasswordInput
        id={`${idPrefix}-new-pw2`}
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
        minLength={minLength}
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
        {busy ? "저장 중…" : registerMode ? "비밀번호 등록" : "비밀번호 저장"}
      </button>
    </section>
  );
}

/** 오너 — 이메일·비밀번호 계정 비밀번호 변경 */
export function OwnerPasswordSettingsCard({ disabled }: { disabled?: boolean }) {
  const [user, setUser] = useState<User | null>(null);
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

  const configured = isFirebaseConfigured();

  useEffect(() => {
    if (!configured) return;
    return onAuthStateChanged(getFirebaseAuth(), setUser);
  }, [configured]);

  const hasPassword = useMemo(
    () => Boolean(user && hasPasswordProvider(user)),
    [user],
  );
  const hasGoogle = useMemo(
    () => Boolean(user?.providerData.some((p) => p.providerId === "google.com")),
    [user],
  );
  const registerMode = Boolean(user?.email && !hasPassword && hasGoogle);
  const canChangePassword = Boolean(user?.email && (hasPassword || registerMode));

  const passwordConfirmHint = resolvePasswordConfirmHint(
    newPassword,
    newPassword2,
    confirmBlurred,
  );

  const onSave = useCallback(async () => {
    setError(null);
    setSaved(false);
    const u = getFirebaseAuth().currentUser;
    if (!u?.email) {
      setError("비밀번호를 변경할 수 없는 계정입니다.");
      return;
    }
    if (!registerMode && !currentPassword) {
      setError("현재 비밀번호를 입력해 주세요.");
      return;
    }
    if (newPassword.length < 8) {
      setError("새 비밀번호는 8자 이상이어야 합니다.");
      return;
    }
    if (newPassword !== newPassword2) {
      setError("새 비밀번호가 서로 일치하지 않습니다.");
      return;
    }
    if (!registerMode && currentPassword === newPassword) {
      setError("새 비밀번호는 현재 비밀번호와 달라야 합니다.");
      return;
    }
    setBusy(true);
    try {
      if (registerMode) {
        const cred = EmailAuthProvider.credential(u.email, newPassword);
        try {
          await linkWithCredential(u, cred);
        } catch (linkErr) {
          if (
            linkErr instanceof FirebaseError &&
            linkErr.code === "auth/requires-recent-login"
          ) {
            await reauthenticateWithPopup(u, new GoogleAuthProvider());
            await linkWithCredential(getFirebaseAuth().currentUser!, cred);
          } else {
            throw linkErr;
          }
        }
      } else {
        const cred = EmailAuthProvider.credential(u.email, currentPassword);
        await reauthenticateWithCredential(u, cred);
        await updatePassword(u, newPassword);
      }
      setSaved(true);
      setCurrentPassword("");
      setNewPassword("");
      setNewPassword2("");
      setConfirmBlurred(false);
    } catch (e) {
      if (e instanceof FirebaseError) {
        if (
          e.code === "auth/wrong-password" ||
          e.code === "auth/invalid-credential"
        ) {
          setError("현재 비밀번호가 올바르지 않습니다.");
          return;
        }
        if (e.code === "auth/requires-recent-login") {
          setError("보안을 위해 다시 로그인한 뒤 비밀번호를 변경해 주세요.");
          return;
        }
        if (e.code === "auth/weak-password") {
          setError("비밀번호가 너무 약합니다. 8자 이상으로 설정해 주세요.");
          return;
        }
      }
      setError(e instanceof FirebaseError ? e.message : "변경에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }, [currentPassword, newPassword, newPassword2, registerMode]);

  const formDisabled = disabled || busy;

  if (!configured || !user) return null;

  if (!canChangePassword) {
    return (
      <section className="glass-card space-y-3 p-4">
        <h2 className="text-sm font-semibold text-foreground">비밀번호</h2>
        <p className="text-[11px] leading-relaxed text-neutral-600">
          이메일이 확인된 계정에서만 비밀번호를 등록하거나 변경할 수 있습니다.
        </p>
      </section>
    );
  }

  return (
    <section className="glass-card space-y-4 p-4">
      <h2 className="text-sm font-semibold text-foreground">
        {registerMode ? "비밀번호 등록" : "비밀번호 변경"}
      </h2>
      <p className="text-[11px] leading-relaxed text-neutral-600">
        {registerMode
          ? "Google 로그인과 함께 이메일·비밀번호 로그인도 사용할 수 있도록 비밀번호를 등록합니다."
          : "오너 로그인에 사용하는 이메일·비밀번호를 변경합니다. Google 연동 본인 확인에도 사용됩니다."}
      </p>
      {!registerMode ? (
        <PasswordInput
          id="owner-cur-pw"
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
      ) : null}
      <PasswordInput
        id="owner-new-pw"
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
        minLength={8}
        autoComplete="new-password"
      />
      <PasswordInput
        id="owner-new-pw2"
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
        minLength={8}
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
        {busy ? "저장 중…" : registerMode ? "비밀번호 등록" : "비밀번호 저장"}
      </button>
    </section>
  );
}

/** 학원 포털 — 학원 ID·비밀번호 로그인용 포털 비밀번호 */
export function AcademyPortalPasswordSettingsCard({
  academyId,
  disabled,
}: {
  academyId: string;
  disabled?: boolean;
}) {
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
      const fn = httpsCallable(getFirebaseFunctions(), "changeAcademyPortalPassword");
      await fn({ academyId, currentPassword, newPassword });
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
  }, [academyId, currentPassword, newPassword, newPassword2]);

  const formDisabled = disabled || busy;

  return (
    <section className="glass-card space-y-4 p-5">
      <h2 className="text-sm font-semibold text-foreground">학원 로그인 비밀번호</h2>
      <p className="text-[11px] leading-relaxed text-neutral-600">
        학원 포털 로그인(
        <span className="font-mono">{academyId}</span>)에 쓰는 비밀번호를 변경합니다.
      </p>
      <PasswordInput
        id="academy-cur-pw"
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
        id="academy-new-pw"
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
        id="academy-new-pw2"
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
