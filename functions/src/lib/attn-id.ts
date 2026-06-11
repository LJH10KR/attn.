/** attn. 계층형 공개 식별자 — Firestore 문서 ID(학원) 및 필드로 사용 */

export const ATTN_ID_GLOBAL_META = "meta/attnGlobal";

/** 역할 접두어 — o=오너, a=학원, t=선생님, p=학부모, s=학생 */
export const ATTN_ROLE_PREFIX = {
  owner: "o",
  academy: "a",
  teacher: "t",
  parent: "p",
  student: "s",
} as const;

/** 선행 0 없는 양의 정수 (1, 2, 10, …) */
const SEQ = "[1-9]\\d*";

export const OWNER_ATTN_ID_RE = new RegExp(`^o${SEQ}$`);
export const ACADEMY_ATTN_ID_RE = new RegExp(`^o${SEQ}_a${SEQ}$`);
export const TEACHER_ATTN_ID_RE = new RegExp(`^o${SEQ}_a${SEQ}_t${SEQ}$`);
export const PARENT_ATTN_ID_RE = new RegExp(`^o${SEQ}_a${SEQ}_p${SEQ}$`);
export const STUDENT_ATTN_ID_RE = new RegExp(`^o${SEQ}_a${SEQ}_p${SEQ}_s${SEQ}$`);

function formatSeq(n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("INVALID_ATTN_SEQ");
  }
  return String(n);
}

export function formatOwnerAttnId(ownerSeq: number): string {
  return `${ATTN_ROLE_PREFIX.owner}${formatSeq(ownerSeq)}`;
}

export function formatAcademyAttnId(ownerAttnId: string, academySeq: number): string {
  return `${ownerAttnId}_${ATTN_ROLE_PREFIX.academy}${formatSeq(academySeq)}`;
}

export function formatTeacherAttnId(academyAttnId: string, teacherSeq: number): string {
  return `${academyAttnId}_${ATTN_ROLE_PREFIX.teacher}${formatSeq(teacherSeq)}`;
}

export function formatParentAttnId(academyAttnId: string, parentSeq: number): string {
  return `${academyAttnId}_${ATTN_ROLE_PREFIX.parent}${formatSeq(parentSeq)}`;
}

export function formatStudentAttnId(parentAttnId: string, studentSeq: number): string {
  return `${parentAttnId}_${ATTN_ROLE_PREFIX.student}${formatSeq(studentSeq)}`;
}

export function isAttnIdLike(value: string): boolean {
  const v = value.trim();
  return (
    OWNER_ATTN_ID_RE.test(v) ||
    ACADEMY_ATTN_ID_RE.test(v) ||
    TEACHER_ATTN_ID_RE.test(v) ||
    PARENT_ATTN_ID_RE.test(v) ||
    STUDENT_ATTN_ID_RE.test(v)
  );
}

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
  const m = attnId.match(new RegExp(`^o(${SEQ})_a(${SEQ})$`));
  if (!m) {
    throw new Error("INVALID_ACADEMY_ATTN_ID");
  }
  return { ownerSeq: m[1]!, academySeq: Number(m[2]) };
}

export function academySeqMetaPath(academyId: string): string {
  return `academies/${academyId}/meta/seq`;
}

export function attnLoginIndexPath(attnId: string): string {
  return `attnLoginIndex/${attnId.replace(/\//g, "_")}`;
}
