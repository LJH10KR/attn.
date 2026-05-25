"use client";

export type SlideSwitchProps = {
  checked: boolean;
  onCheckedChangeAction: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
};

/** 학부모 푸시 알림 카드와 동일한 슬라이드 토글 */
export function SlideSwitch({
  checked,
  onCheckedChangeAction,
  disabled = false,
  ariaLabel,
  className = "",
}: SlideSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChangeAction(!checked)}
      className={`relative h-9 w-[3.25rem] shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        checked ? "bg-emerald-600" : "bg-neutral-300 dark:bg-neutral-600"
      } ${className}`}
    >
      <span
        className={`absolute top-1 left-1 h-7 w-7 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-[1.35rem]" : "translate-x-0"
        }`}
      />
    </button>
  );
}
