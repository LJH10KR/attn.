"use client";

import { useState } from "react";
import { PasswordInput } from "@/components/ui/password-input";
import type { ReauthMethod } from "@/lib/firebase/recent-reauth";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

/**
 * 되돌릴 수 없는 작업 직전 본인 확인 + 실행 버튼(2-N 탈퇴·학원 삭제 공용).
 * 비밀번호로 확인할 수 있으면 비밀번호 칸 + [submitLabel], Google 계정이면 [Google로 다시 로그인하고 …] — 둘 다 되면 둘 다.
 * 버튼을 누르면 `onConfirmAction(방법)` — 재확인·서버 호출은 부모가 한다.
 */
export function ReauthActionForm({
  idPrefix,
  passwordKind,
  google,
  submitLabel,
  busy,
  onConfirmAction,
}: {
  idPrefix: string;
  /** member = 로그인 ID 비밀번호, owner = 이메일 원장 비밀번호, null = 비밀번호 없음 */
  passwordKind: "member" | "owner" | null;
  google: boolean;
  submitLabel: string;
  busy: boolean;
  onConfirmAction: (method: ReauthMethod) => void;
}) {
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const dangerButton =
    "w-full rounded-2xl bg-red-600 py-3 text-sm font-medium text-white disabled:opacity-50";

  return (
    <div className="space-y-3">
      {passwordKind ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!password || busy) return;
            onConfirmAction({ kind: passwordKind, password });
          }}
        >
          <PasswordInput
            id={`${idPrefix}-password`}
            label="비밀번호"
            value={password}
            onChangeAction={setPassword}
            visible={visible}
            onToggleVisibleAction={() => setVisible((v) => !v)}
            inputClassName={inputClass}
            labelClassName="mb-1 block text-xs font-medium text-neutral-600"
            disabled={busy}
            autoComplete="current-password"
          />
          <button type="submit" disabled={busy || !password} className={dangerButton} data-testid={`${idPrefix}-submit`}>
            {submitLabel}
          </button>
        </form>
      ) : null}
      {google ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onConfirmAction({ kind: "google" })}
          className={
            passwordKind
              ? "w-full rounded-2xl border border-red-300/70 bg-white/50 py-3 text-sm font-medium text-red-700 disabled:opacity-50 dark:bg-white/[0.06]"
              : dangerButton
          }
          data-testid={`${idPrefix}-google`}
        >
          Google로 다시 로그인하고 {submitLabel}
        </button>
      ) : null}
      {!passwordKind && !google ? (
        <p className="text-sm text-red-700">본인 확인 방법을 찾지 못했어요. 다시 로그인한 뒤 시도해 주세요.</p>
      ) : null}
    </div>
  );
}
