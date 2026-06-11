"use client";

import { PasswordInput } from "@/components/ui/password-input";

const defaultInputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3.5 text-foreground shadow-inner shadow-white/40 outline-none focus:border-[#4a90e2]/50 focus:bg-white/70 focus:shadow-[0_0_0_3px_rgba(74,144,226,0.18)]";

export function LoginPasswordField({
  id,
  label,
  value,
  onChangeAction,
  visible,
  onToggleVisibleAction,
  disabled,
  autoComplete = "current-password",
  inputClassName = defaultInputClass,
}: {
  id: string;
  label: string;
  value: string;
  onChangeAction: (value: string) => void;
  visible: boolean;
  onToggleVisibleAction: () => void;
  disabled?: boolean;
  autoComplete?: "current-password" | "new-password";
  inputClassName?: string;
}) {
  return (
    <PasswordInput
      id={id}
      label={label}
      value={value}
      onChangeAction={onChangeAction}
      visible={visible}
      onToggleVisibleAction={onToggleVisibleAction}
      inputClassName={inputClassName}
      labelClassName="mb-1.5 block text-xs font-medium text-neutral-600"
      disabled={disabled}
      autoComplete={autoComplete}
      required
    />
  );
}
