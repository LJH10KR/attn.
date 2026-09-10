import { assemble, disassemble } from "es-hangul";

/** 자모 한 글자를 이어 붙여 한글 음절로 조합합니다. */
export function appendHangulJamo(text: string, jamo: string): string {
  return assemble([disassemble(text) + jamo]);
}

/** 마지막 자모 또는 음절을 제거합니다. */
export function backspaceHangul(text: string): string {
  if (!text) return "";
  if (text.endsWith(" ")) {
    return text.slice(0, -1);
  }
  const jamos = disassemble(text);
  if (!jamos) return "";
  const next = jamos.slice(0, -1);
  // assemble([])는 es-hangul 내부에서 예외를 던짐 — 초기화(X)는 setQuery("")라서 안전
  if (!next) return "";
  return assemble([next]);
}
