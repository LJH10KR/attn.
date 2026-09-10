"use client";

import { KioskKeypadButton, KioskKeypadShell } from "@/components/academy/kiosk-keypad-shell";

const ROWS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
] as const;

type Props = {
  onDigitAction: (digit: string) => void;
  onBackspaceAction: () => void;
};

export function KioskNumericKeypad({ onDigitAction, onBackspaceAction }: Props) {
  return (
    <KioskKeypadShell>
      <div className="mx-auto flex max-w-lg flex-col gap-1.5">
        {ROWS.map((row, ri) => (
          <div key={ri} className="grid grid-cols-3 gap-1.5">
            {row.map((d) => (
              <KioskKeypadButton key={d} onClickAction={() => onDigitAction(d)}>
                {d}
              </KioskKeypadButton>
            ))}
          </div>
        ))}
        <div className="grid grid-cols-3 gap-1.5">
          <div aria-hidden />
          <KioskKeypadButton onClickAction={() => onDigitAction("0")}>0</KioskKeypadButton>
          <KioskKeypadButton ariaLabel="지우기" onClickAction={onBackspaceAction}>
            ⌫
          </KioskKeypadButton>
        </div>
      </div>
    </KioskKeypadShell>
  );
}
