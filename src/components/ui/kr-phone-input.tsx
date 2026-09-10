"use client";

import { formatKrPhoneInput, KR_PHONE_INPUT_MAX_LENGTH } from "@/lib/phone/kr-phone";
import type { InputHTMLAttributes } from "react";

export type KrPhoneInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "inputMode" | "maxLength" | "value" | "onChange"
> & {
  value: string;
  onChange: (value: string) => void;
};

export function KrPhoneInput({
  value,
  onChange,
  placeholder = "010-1234-5678",
  ...rest
}: KrPhoneInputProps) {
  return (
    <input
      type="tel"
      inputMode="numeric"
      autoComplete="tel"
      placeholder={placeholder}
      maxLength={KR_PHONE_INPUT_MAX_LENGTH}
      value={value}
      onChange={(e) => onChange(formatKrPhoneInput(e.target.value))}
      {...rest}
    />
  );
}
