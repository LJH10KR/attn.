/**
 * CSV 내보내기 — 원생 목록에서 먼저 쓰고 반·수납·결제 내역에서 재사용.
 * - 엑셀이 한글을 깨뜨리지 않게 UTF-8 BOM + CRLF
 * - 수식 주입 방지: `= + - @ 탭 CR`로 시작하는 값은 앞에 `'`
 * - 쉼표·따옴표·줄바꿈이 있으면 큰따옴표로 감싸고 안의 `"`는 `""`
 */

export type CsvColumn<T> = {
  header: string;
  value: (row: T) => string | number | null | undefined;
};

const FORMULA_PREFIX_RE = /^[=+\-@\t\r]/;
const NEEDS_QUOTE_RE = /[",\r\n]/;

export function csvCell(raw: string | number | null | undefined): string {
  let s = raw === null || raw === undefined ? "" : String(raw);
  if (FORMULA_PREFIX_RE.test(s)) s = `'${s}`;
  return NEEDS_QUOTE_RE.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  const lines = [
    columns.map((c) => csvCell(c.header)).join(","),
    ...rows.map((row) => columns.map((c) => csvCell(c.value(row))).join(",")),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function downloadCsv<T>(fileName: string, columns: readonly CsvColumn<T>[], rows: readonly T[]): void {
  const blob = new Blob([toCsv(columns, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
