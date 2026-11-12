/**
 * 원생 여러 명 입력 표(2-M) — 붙여 넣기 해석·학년 해석·줄 검사.
 * 서버 `functions/src/lib/student-bulk.ts` ↔ 화면 `src/lib/academy/student-bulk.ts`(같은 내용, 단위 테스트가 비교).
 * Firebase를 쓰지 않는 순수 함수만 둔다(서버 저장 함수 `createStudentsBulk`·화면 표가 같은 판단을 씀).
 *
 * 두 단계로 나눈다.
 * 1. 글자 → 값(화면): 학년 글자 → 코드, 관계 이름 → 선택지 id, 반 이름 → 반 id(`resolveBulkStudentDraft`).
 * 2. 값 검사(화면·서버 공통): 이름·학년·학교·번호·관계·반(`validateBulkStudentInput`).
 */

import { isGradeCode, type GradeCode } from "./student-profile";

export const MAX_BULK_STUDENTS = 200;
export const BULK_STUDENT_NAME_MAX = 40;
export const BULK_STUDENT_SCHOOL_MAX = 40;

/** 표 칸(고정 순서 = 머리글 없는 붙여 넣기 순서) */
export const BULK_STUDENT_COLUMNS = [
  "name",
  "grade",
  "school",
  "g1Relation",
  "g1Phone",
  "g2Relation",
  "g2Phone",
  "className",
] as const;
export type BulkStudentColumn = (typeof BULK_STUDENT_COLUMNS)[number];

export const BULK_STUDENT_COLUMN_LABELS: Record<BulkStudentColumn, string> = {
  name: "이름",
  grade: "학년",
  school: "학교",
  g1Relation: "보호자1 관계",
  g1Phone: "보호자1 번호",
  g2Relation: "보호자2 관계",
  g2Phone: "보호자2 번호",
  className: "반",
};

/** 표 한 줄의 글자 값 */
export type BulkStudentDraft = Record<BulkStudentColumn, string>;

export function emptyBulkStudentDraft(): BulkStudentDraft {
  return { name: "", grade: "", school: "", g1Relation: "", g1Phone: "", g2Relation: "", g2Phone: "", className: "" };
}

export function isBlankBulkStudentDraft(d: BulkStudentDraft): boolean {
  return BULK_STUDENT_COLUMNS.every((c) => d[c].trim() === "");
}

// ---------------------------------------------------------------------------
// 붙여 넣기 해석
// ---------------------------------------------------------------------------

/**
 * 엑셀·구글 시트에서 복사한 글자(탭 구분) → 칸 배열.
 * 줄: CRLF·LF·CR. 칸: 탭. `"`로 시작하는 칸은 닫는 `"`까지 한 칸(안의 줄바꿈·탭 포함, `""` = `"`).
 * 칸 앞뒤 공백을 없애고, 끝의 빈 줄과 모든 칸이 빈 줄은 버린다.
 */
export function parsePastedTable(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let cellStart = true;
  const pushCell = () => {
    row.push(cell.trim());
    cell = "";
    cellStart = true;
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (cellStart && ch === "\"") {
      // 따옴표 칸
      let j = i + 1;
      let quoted = "";
      let closed = false;
      while (j < text.length) {
        const c = text[j]!;
        if (c === "\"") {
          if (text[j + 1] === "\"") {
            quoted += "\"";
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        quoted += c;
        j += 1;
      }
      if (closed) {
        cell = quoted;
        cellStart = false;
        i = j;
        continue;
      }
      // 닫히지 않은 따옴표 — 그냥 글자로
    }
    cellStart = false;
    if (ch === "\t") {
      pushCell();
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      pushRow();
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (cell !== "" || row.length > 0) pushRow();
  return rows.filter((r) => r.some((c) => c !== ""));
}

function headerToken(raw: string): string {
  return raw.replace(/[\s()（）*·_\-.]/g, "").toLowerCase();
}

const HEADER_WORDS: Record<BulkStudentColumn, readonly string[]> = {
  name: ["이름", "학생", "학생이름", "학생명", "원생", "원생이름", "성명"],
  grade: ["학년"],
  school: ["학교", "학교명"],
  g1Relation: ["관계", "보호자관계", "보호자1관계", "관계1"],
  g1Phone: [
    "번호", "연락처", "전화", "전화번호", "휴대폰", "휴대폰번호", "보호자번호", "보호자연락처",
    "보호자1번호", "보호자1연락처", "번호1", "연락처1",
  ],
  g2Relation: ["보호자2관계", "관계2"],
  g2Phone: ["보호자2번호", "보호자2연락처", "번호2", "연락처2"],
  className: ["반", "반이름", "수업"],
};

function headerColumnOf(raw: string): BulkStudentColumn | null {
  const t = headerToken(raw);
  if (!t) return null;
  for (const col of BULK_STUDENT_COLUMNS) {
    if (HEADER_WORDS[col].includes(t)) return col;
  }
  return null;
}

/** 휴대폰 번호처럼 보이는 칸(숫자 9자리 이상) */
function looksLikePhone(raw: string): boolean {
  return raw.replace(/\D/g, "").length >= 9;
}

export type PastedHeader = {
  /** 붙여 넣은 칸 순서 → 표 칸(모르는 칸은 null) */
  columns: (BulkStudentColumn | null)[];
  /** 무시한 머리글 */
  ignored: string[];
};

/**
 * 첫 줄이 머리글인지 — 머리글 낱말 칸이 2개 이상이고 휴대폰 번호 모양 칸이 없으면 머리글.
 * 같은 표 칸이 두 번 나오면 두 번째는 무시.
 */
export function detectPastedHeader(firstRow: readonly string[]): PastedHeader | null {
  if (firstRow.some(looksLikePhone)) return null;
  const used = new Set<BulkStudentColumn>();
  const columns: (BulkStudentColumn | null)[] = [];
  const ignored: string[] = [];
  let known = 0;
  for (const cell of firstRow) {
    const col = headerColumnOf(cell);
    if (col && !used.has(col)) {
      used.add(col);
      columns.push(col);
      known += 1;
    } else {
      columns.push(null);
      if (cell.trim()) ignored.push(cell.trim());
    }
  }
  return known >= 2 ? { columns, ignored } : null;
}

export type PastedRowsResult = {
  drafts: BulkStudentDraft[];
  headerDetected: boolean;
  ignoredHeaders: string[];
  /** 200줄을 넘어 버린 줄 수 */
  droppedCount: number;
};

/**
 * 붙여 넣은 글자 → 표 줄. 머리글이 있으면 머리글 이름으로 칸을 맞추고(붙여 넣은 칸 위치와 무관),
 * 없으면 `startColumn`(붙여 넣은 칸)부터 고정 순서로 채운다. `limit`줄까지만.
 */
export function pastedTextToDrafts(
  text: string,
  opts: { startColumn?: number; limit?: number } = {},
): PastedRowsResult {
  const limit = opts.limit ?? MAX_BULK_STUDENTS;
  const table = parsePastedTable(text);
  if (table.length === 0) return { drafts: [], headerDetected: false, ignoredHeaders: [], droppedCount: 0 };
  const header = detectPastedHeader(table[0]!);
  const body = header ? table.slice(1) : table;
  const start = Math.max(0, Math.min(BULK_STUDENT_COLUMNS.length - 1, opts.startColumn ?? 0));
  const drafts = body.map((cells) => {
    const d = emptyBulkStudentDraft();
    cells.forEach((value, i) => {
      const col = header ? header.columns[i] ?? null : BULK_STUDENT_COLUMNS[start + i] ?? null;
      if (col) d[col] = value;
    });
    return d;
  }).filter((d) => !isBlankBulkStudentDraft(d));
  return {
    drafts: drafts.slice(0, limit),
    headerDetected: header !== null,
    ignoredHeaders: header?.ignored ?? [],
    droppedCount: Math.max(0, drafts.length - limit),
  };
}

// ---------------------------------------------------------------------------
// 학년·번호 해석
// ---------------------------------------------------------------------------

const SCHOOL_PREFIX: Record<string, "e" | "m" | "h"> = {
  초: "e", 초등: "e", 초등학교: "e", 초교: "e",
  중: "m", 중학: "m", 중학교: "m",
  고: "h", 고등: "h", 고등학교: "h", 고교: "h",
};

/**
 * 학년 글자 → 코드. `초1`·`초등1`·`초등학교 1학년`·`중2`·`고등 3학년`, `미취학`·`유치(원)`, `성인`·`성인·기타`·`기타`·`일반`.
 * 띄어쓰기 무시. `졸업`·`1학년`처럼 학교를 알 수 없거나 범위를 넘으면 null. 코드(`e3`)도 받는다.
 */
export function parseGradeText(raw: string): GradeCode | null {
  const t = raw.replace(/\s/g, "").replace(/[·.]/g, "").toLowerCase();
  if (!t) return null;
  if (isGradeCode(t)) return t;
  if (t === "미취학" || t === "유치" || t === "유치원") return "preschool";
  if (t === "성인" || t === "성인기타" || t === "기타" || t === "일반") return "adult";
  const m = t.match(/^(초등학교|초등|초교|초|중학교|중학|중|고등학교|고등|고교|고)(\d)(학년)?$/);
  if (!m) return null;
  const level = SCHOOL_PREFIX[m[1]!]!;
  const n = Number(m[2]);
  const max = level === "e" ? 6 : 3;
  if (n < 1 || n > max) return null;
  const code = `${level}${n}`;
  return isGradeCode(code) ? code : null;
}

/**
 * 휴대폰 번호 → 저장 형식(010-1234-5678) — 숫자만 남기고 +82/82는 0으로, 10~11자리·01로 시작만.
 * 서버 `assertKrPhoneRequired`와 같은 범위(그 함수가 최종 검사).
 */
export function normalizeBulkPhone(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("82") && (d.length === 11 || d.length === 12)) d = `0${d.slice(2)}`;
  if (d.length < 10 || d.length > 11 || !d.startsWith("01")) return null;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}

export function bulkPhoneKey(phone: string): string {
  return phone.replace(/\D/g, "");
}

// ---------------------------------------------------------------------------
// 값 검사(화면·서버 공통)
// ---------------------------------------------------------------------------

export type BulkGuardianInput = { relationId: string | null; phone: string };

/** 서버에 보내는 한 줄 */
export type BulkStudentInput = {
  rowKey: string;
  name: string;
  grade: string;
  school: string;
  guardians: BulkGuardianInput[];
  classId: string | null;
  allowDuplicate: boolean;
};

export type BulkFieldError = { field: BulkStudentColumn | "row"; message: string };

export type BulkClassOption = { id: string; name: string; status: string };
export type BulkRelationOption = { id: string; label: string };

export const BULK_MSG = {
  nameRequired: "이름을 입력해 주세요.",
  nameTooLong: `이름은 ${BULK_STUDENT_NAME_MAX}자 이하로 입력해 주세요.`,
  gradeRequired: "학년을 입력해 주세요.",
  gradeUnknown: "학년을 알 수 없어요(예: 초3, 중1, 고2, 미취학, 성인).",
  schoolTooLong: `학교는 ${BULK_STUDENT_SCHOOL_MAX}자 이하로 입력해 주세요.`,
  phoneFormat: (n: 1 | 2) => `보호자${n} 번호 형식을 확인해 주세요(010으로 시작하는 10~11자리).`,
  phoneMissing: (n: 1 | 2) => `보호자${n} 번호를 입력해 주세요.`,
  relationUnknown: (label: string) => `보호자 관계 ‘${label}’가 선택지에 없어요. 다시 골라 주세요.`,
  samePhoneTwice: "같은 번호의 보호자가 두 번 들어 있습니다.",
  classMissing: (name: string) => `‘${name}’ 반이 없어요. 반 관리에서 먼저 만들어 주세요.`,
  classAmbiguous: "같은 이름의 반이 여러 개예요. 반 관리에서 이름을 바꿔 주세요.",
  classEnded: "종강한 반에는 원생을 추가할 수 없습니다. 반을 다시 열어 주세요.",
  classGone: "선택한 반을 찾을 수 없어요. 새로고침한 뒤 다시 골라 주세요.",
  relationGone: "선택한 보호자 관계가 삭제되었습니다. 다시 선택해 주세요.",
  classNoPermission: "반 배정 권한이 없어요. 반 칸을 비워 주세요.",
  duplicateExisting: "같은 이름·학년 원생이 이미 있어요.",
  duplicateInTable: "표 안에 같은 이름·학년 줄이 있어요.",
  duplicateServer: "같은 이름·학년 원생이 이미 있어요. 동명이인이면 확인한 뒤 다시 저장해 주세요.",
} as const;

/** 반 이름 → 반(정확히 같은 이름, 앞뒤 공백 무시) */
export function resolveBulkClass(
  name: string,
  classes: readonly BulkClassOption[],
): { classId: string } | { error: string } | null {
  const t = name.trim();
  if (!t) return null;
  const hits = classes.filter((c) => c.name.trim() === t);
  if (hits.length === 0) return { error: BULK_MSG.classMissing(t) };
  if (hits.length > 1) return { error: BULK_MSG.classAmbiguous };
  if (hits[0]!.status === "ended") return { error: BULK_MSG.classEnded };
  return { classId: hits[0]!.id };
}

/** 관계 이름 → 선택지 id(정확히 같은 이름, 대소문자 무시). 비었으면 null */
export function resolveBulkRelation(
  label: string,
  relations: readonly BulkRelationOption[],
): { relationId: string | null } | { error: string } {
  const t = label.trim();
  if (!t) return { relationId: null };
  const hit = relations.find((r) => r.label.trim().toLowerCase() === t.toLowerCase() || r.id === t);
  return hit ? { relationId: hit.id } : { error: BULK_MSG.relationUnknown(t) };
}

/**
 * 표 한 줄(글자) → 서버로 보낼 값 + 칸별 오류. 오류가 있으면 `input`은 null.
 */
export function resolveBulkStudentDraft(
  draft: BulkStudentDraft,
  ctx: {
    rowKey: string;
    relations: readonly BulkRelationOption[];
    classes: readonly BulkClassOption[];
    canAssignClass: boolean;
    allowDuplicate: boolean;
  },
): { input: BulkStudentInput | null; errors: BulkFieldError[] } {
  const errors: BulkFieldError[] = [];
  const name = draft.name.trim();
  const gradeText = draft.grade.trim();
  const grade = gradeText ? parseGradeText(gradeText) : null;
  if (gradeText && !grade) errors.push({ field: "grade", message: BULK_MSG.gradeUnknown });

  const guardians: BulkGuardianInput[] = [];
  ([1, 2] as const).forEach((n) => {
    const relCol: BulkStudentColumn = n === 1 ? "g1Relation" : "g2Relation";
    const phoneCol: BulkStudentColumn = n === 1 ? "g1Phone" : "g2Phone";
    const relText = draft[relCol].trim();
    const phoneText = draft[phoneCol].trim();
    const rel = resolveBulkRelation(relText, ctx.relations);
    if ("error" in rel) errors.push({ field: relCol, message: rel.error });
    if (!phoneText) {
      if (relText) errors.push({ field: phoneCol, message: BULK_MSG.phoneMissing(n) });
      return;
    }
    const phone = normalizeBulkPhone(phoneText);
    if (!phone) {
      errors.push({ field: phoneCol, message: BULK_MSG.phoneFormat(n) });
      return;
    }
    guardians.push({ relationId: "relationId" in rel ? rel.relationId : null, phone });
  });

  let classId: string | null = null;
  if (draft.className.trim()) {
    if (!ctx.canAssignClass) {
      errors.push({ field: "className", message: BULK_MSG.classNoPermission });
    } else {
      const c = resolveBulkClass(draft.className, ctx.classes);
      if (c && "error" in c) errors.push({ field: "className", message: c.error });
      else if (c) classId = c.classId;
    }
  }

  const input: BulkStudentInput = {
    rowKey: ctx.rowKey,
    name,
    grade: grade ?? "",
    school: draft.school.trim(),
    guardians,
    classId,
    allowDuplicate: ctx.allowDuplicate,
  };
  for (const e of validateBulkStudentInput(input, {
    relationIds: new Set(ctx.relations.map((r) => r.id)),
    classes: ctx.classes,
    canAssignClass: ctx.canAssignClass,
  })) {
    // 글자 단계에서 이미 같은 칸 오류가 있으면 겹치지 않게
    if (!errors.some((x) => x.field === e.field)) errors.push(e);
  }
  return { input: errors.length === 0 ? input : null, errors };
}

/**
 * 값 검사 — 서버(`createStudentsBulk`)가 받은 값을 다시 검사하는 것과 같은 함수.
 * 보호자 번호의 최종 형식 검사·관계 삭제 검사는 서버의 `parseGuardiansInput`도 한 번 더 한다.
 */
export function validateBulkStudentInput(
  input: Pick<BulkStudentInput, "name" | "grade" | "school" | "guardians" | "classId">,
  ctx: { relationIds: ReadonlySet<string>; classes: readonly BulkClassOption[]; canAssignClass: boolean },
): BulkFieldError[] {
  const errors: BulkFieldError[] = [];
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) errors.push({ field: "name", message: BULK_MSG.nameRequired });
  else if (name.length > BULK_STUDENT_NAME_MAX) errors.push({ field: "name", message: BULK_MSG.nameTooLong });

  if (!input.grade) errors.push({ field: "grade", message: BULK_MSG.gradeRequired });
  else if (!isGradeCode(input.grade)) errors.push({ field: "grade", message: BULK_MSG.gradeUnknown });

  const school = typeof input.school === "string" ? input.school.trim() : "";
  if (school.length > BULK_STUDENT_SCHOOL_MAX) errors.push({ field: "school", message: BULK_MSG.schoolTooLong });

  const guardians = Array.isArray(input.guardians) ? input.guardians : [];
  if (guardians.length > 2) errors.push({ field: "row", message: "보호자는 두 명까지 입력할 수 있어요." });
  const keys = new Set<string>();
  guardians.slice(0, 2).forEach((g, i) => {
    const n = (i + 1) as 1 | 2;
    const phoneCol: BulkStudentColumn = n === 1 ? "g1Phone" : "g2Phone";
    const relCol: BulkStudentColumn = n === 1 ? "g1Relation" : "g2Relation";
    const phone = typeof g?.phone === "string" ? normalizeBulkPhone(g.phone) : null;
    if (!phone) {
      errors.push({ field: phoneCol, message: BULK_MSG.phoneFormat(n) });
      return;
    }
    const key = bulkPhoneKey(phone);
    if (keys.has(key)) errors.push({ field: phoneCol, message: BULK_MSG.samePhoneTwice });
    keys.add(key);
    if (g.relationId !== null && g.relationId !== undefined && !ctx.relationIds.has(g.relationId)) {
      errors.push({ field: relCol, message: BULK_MSG.relationGone });
    }
  });

  if (input.classId) {
    if (!ctx.canAssignClass) {
      errors.push({ field: "className", message: BULK_MSG.classNoPermission });
    } else {
      const c = ctx.classes.find((x) => x.id === input.classId);
      if (!c) errors.push({ field: "className", message: BULK_MSG.classGone });
      else if (c.status === "ended") errors.push({ field: "className", message: BULK_MSG.classEnded });
    }
  }
  return errors;
}

/** 동명이인 비교 키 — 이름(앞뒤 공백 제거) + 지금 보이는 학년 코드 */
export function bulkDuplicateKey(name: string, displayGradeCode: string | null): string {
  return `${name.trim()}|${displayGradeCode ?? ""}`;
}

/** 표 안에서 이름·학년이 같은 줄들의 위치(2줄 이상인 것만) */
export function bulkInTableDuplicates(keys: readonly (string | null)[]): Set<number> {
  const seen = new Map<string, number[]>();
  keys.forEach((k, i) => {
    if (!k) return;
    seen.set(k, [...(seen.get(k) ?? []), i]);
  });
  const out = new Set<number>();
  for (const idx of seen.values()) if (idx.length > 1) idx.forEach((i) => out.add(i));
  return out;
}
