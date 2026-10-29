/** `/academy`로만 들어왔을 때 원장이 마지막으로 보던 학원 — 기기(localStorage)에 계정별로 저장 */
function lastAcademyStorageKey(uid: string): string {
  return `attn_last_academy_${uid}`;
}

export function rememberLastAcademy(uid: string, academyId: string): void {
  try {
    localStorage.setItem(lastAcademyStorageKey(uid), academyId);
  } catch {
    /* ignore */
  }
}

export function readLastAcademy(uid: string): string | null {
  try {
    return localStorage.getItem(lastAcademyStorageKey(uid)) || null;
  } catch {
    return null;
  }
}
