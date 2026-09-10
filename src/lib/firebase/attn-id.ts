/**
 * attn. 공개 식별자 형식 — Functions `lib/attn-id.ts`와 동기화
 * o=오너, a=학원, t=선생님, p=학부모, s=학생 (숫자는 선행 0 없이 1부터 증가)
 */

const SEQ = "[1-9]\\d*";

export const OWNER_ATTN_ID_RE = new RegExp(`^o${SEQ}$`);
export const ACADEMY_ATTN_ID_RE = new RegExp(`^o${SEQ}_a${SEQ}$`);
export const TEACHER_ATTN_ID_RE = new RegExp(`^o${SEQ}_a${SEQ}_t${SEQ}$`);
export const PARENT_ATTN_ID_RE = new RegExp(`^o${SEQ}_a${SEQ}_p${SEQ}$`);
export const STUDENT_ATTN_ID_RE = new RegExp(`^o${SEQ}_a${SEQ}_p${SEQ}_s${SEQ}$`);

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
