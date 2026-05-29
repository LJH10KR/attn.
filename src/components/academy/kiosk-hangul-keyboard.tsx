"use client";

import { KioskKeypadButton, KioskKeypadShell } from "@/components/academy/kiosk-keypad-shell";

/** 두벌식 자판 배열(키오스크용 — 쌍자음은 기본 키 조합으로 입력) */
const ROWS = [
  ["ㅂ", "ㅈ", "ㄷ", "ㄱ", "ㅅ", "ㅛ", "ㅕ", "ㅑ", "ㅐ", "ㅔ"],
  ["ㅁ", "ㄴ", "ㅇ", "ㄹ", "ㅎ", "ㅗ", "ㅓ", "ㅏ", "ㅣ"],
  ["ㅋ", "ㅌ", "ㅊ", "ㅍ", "ㅠ", "ㅜ", "ㅡ"],
] as const;

type Props = {
  onJamoAction: (jamo: string) => void;
  onSpaceAction: () => void;
  onBackspaceAction: () => void;
};

export function KioskHangulKeyboard({ onJamoAction, onSpaceAction, onBackspaceAction }: Props) {
  return (
    <KioskKeypadShell>
      <div className="mx-auto flex max-w-lg flex-col gap-1.5">
        {ROWS.map((row, ri) => (
          <div
            key={ri}
            className="grid gap-1.5"
            style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}
          >
            {row.map((jamo) => (
              <KioskKeypadButton key={jamo} onClickAction={() => onJamoAction(jamo)}>
                {jamo}
              </KioskKeypadButton>
            ))}
          </div>
        ))}
        <div className="grid grid-cols-[1fr_auto] gap-1.5">
          <KioskKeypadButton className="h-11" onClickAction={onSpaceAction}>
            공백
          </KioskKeypadButton>
          <KioskKeypadButton
            className="min-w-[4.5rem]"
            ariaLabel="지우기"
            onClickAction={onBackspaceAction}
          >
            ⌫
          </KioskKeypadButton>
        </div>
      </div>
    </KioskKeypadShell>
  );
}
