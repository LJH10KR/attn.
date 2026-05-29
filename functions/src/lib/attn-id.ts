/** attn. 계층형 공개 식별자 — Firestore 문서 ID(학원) 및 필드로 사용 */

export const ATTN_ID_GLOBAL_META = "meta/attnGlobal";

export function pad5(n: number): string {
  return String(n).padStart(5, "0");
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

export function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

export function formatAcademyAttnId(ownerSeq: string, academySeq: number): string {
  return `${ownerSeq}_${pad2(academySeq)}`;
}

export function formatTeacherAttnId(academyAttnId: string, teacherSeq: number): string {
  return `${academyAttnId}_${pad3(teacherSeq)}`;
}

export function formatParentAttnId(academyAttnId: string, parentSeq: number): string {
  return `${academyAttnId}_${pad4(parentSeq)}`;
}

export function formatStudentAttnId(parentAttnId: string, studentSeq: number): string {
  return `${parentAttnId}_${pad2(studentSeq)}`;
}

const ACADEMY_ATTN_ID_RE = /^\d{5}_\d{2}$/;
const TEACHER_ATTN_ID_RE = /^\d{5}_\d{2}_\d{3}$/;
const PARENT_ATTN_ID_RE = /^\d{5}_\d{2}_\d{4}$/;
export function assertValidAcademyAttnId(attnId: string): void {
  if (!ACADEMY_ATTN_ID_RE.test(attnId)) {
    throw new Error("INVALID_ACADEMY_ATTN_ID");
  }
}

export function assertValidTeacherAttnId(attnId: string): void {
  if (!TEACHER_ATTN_ID_RE.test(attnId)) {
    throw new Error("INVALID_TEACHER_ATTN_ID");
  }
}

export function assertValidParentAttnId(attnId: string): void {
  if (!PARENT_ATTN_ID_RE.test(attnId)) {
    throw new Error("INVALID_PARENT_ATTN_ID");
  }
}

export function parseAcademyAttnId(attnId: string): { ownerSeq: string; academySeq: number } {
  assertValidAcademyAttnId(attnId);
  const [ownerSeq, ac] = attnId.split("_");
  return { ownerSeq: ownerSeq!, academySeq: Number(ac) };
}

export function academySeqMetaPath(academyId: string): string {
  return `academies/${academyId}/meta/seq`;
}

export function attnLoginIndexPath(attnId: string): string {
  return `attnLoginIndex/${attnId.replace(/\//g, "_")}`;
}
