/** attnId(또는 동일 형식 문서 id) 기준 오름차순 — 대시보드 목록 기본 정렬 */
export function compareAttnIdAsc(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function attnIdSortKey(row: { attnId?: string; id?: string }): string {
  return row.attnId ?? row.id ?? "";
}
