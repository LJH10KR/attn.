"use client";

import type { ReactNode } from "react";
import {
  PASSWORD_MATCH_MSG,
  PASSWORD_MISMATCH_MSG,
  type PasswordConfirmHint,
} from "@/lib/ui/password-confirm-hint";

function EyeOpenIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 3l18 18M10.5 10.7A3 3 0 0 0 12 15a3 3 0 0 0 2.3-1M6.7 6.8C4.6 8.4 3 10.5 2 12s3.5 7 10 7c1.8 0 3.4-.4 4.8-1.1M17.3 17.2C19.4 15.6 21 13.5 22 12s-3.5-7-10-7c-1.8 0-3.4.4-4.8 1.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export type PasswordInputProps = {
  id: string;
  label: ReactNode;
  value: string;
  onChangeAction: (next: string) => void;
  onBlurAction?: () => void;
  visible: boolean;
  onToggleVisibleAction: () => void;
  confirmHint?: PasswordConfirmHint;
  inputClassName: string;
  labelClassName?: string;
  disabled?: boolean;
  autoComplete?: "new-password" | "current-password";
  minLength?: number;
  required?: boolean;
};

export function PasswordInput({
  id,
  label,
  value,
  onChangeAction,
  onBlurAction,
  visible,
  onToggleVisibleAction,
  confirmHint = "none",
  inputClassName,
  labelClassName = "mb-1.5 block text-xs font-medium text-neutral-600",
  disabled = false,
  autoComplete = "new-password",
  minLength,
  required,
}: PasswordInputProps) {
  return (
    <div>
      <label className={labelClassName} htmlFor={id}>
        {label}
      </label>
      <div className="relative mt-2">
        <input
          id={id}
          type={visible ? "text" : "password"}
          className={`${inputClassName} pr-12`}
          value={value}
          onChange={(e) => onChangeAction(e.target.value)}
          onBlur={onBlurAction}
          autoComplete={autoComplete}
          disabled={disabled}
          required={required}
          minLength={minLength}
          aria-invalid={confirmHint === "mismatch"}
          aria-describedby={confirmHint !== "none" ? `${id}-hint` : undefined}
        />
        <button
          type="button"
          onClick={onToggleVisibleAction}
          disabled={disabled}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-foreground disabled:opacity-50"
          aria-label={visible ? "비밀번호 숨기기" : "비밀번호 보기"}
        >
          {visible ? <EyeOffIcon /> : <EyeOpenIcon />}
        </button>
      </div>
      {confirmHint === "match" ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          {PASSWORD_MATCH_MSG}
        </p>
      ) : null}
      {confirmHint === "mismatch" ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-red-600 dark:text-red-400">
          {PASSWORD_MISMATCH_MSG}
        </p>
      ) : null}
    </div>
  );
}
