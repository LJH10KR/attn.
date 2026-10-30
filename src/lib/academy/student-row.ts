import type { AcademyOptionItem, StudentGuardian, TuitionType } from "@/lib/firebase/attn-schema";
import {
  displayGrade,
  gradeLabel,
  isGradeCode,
  normalizeStudentStatus,
  type DisplayGrade,
  type GradeCode,
  type StudentStatus,
} from "@/lib/academy/student-profile";

/**
 * 원생 화면용 학생 값 — 원생 목록·학생 상세 시트·반·학부모 화면이 같이 쓴다.
 * 원비·회차 필드는 4단계까지 기존 이름 그대로(D11).
 */

/** 원비 설정·충전·수업 완료 모달이 쓰는 값 */
export type StudentTuitionTarget = {
  id: string;
  name: string;
  tuitionType?: TuitionType | null;
  tuitionDueDayOfMonth?: number | null;
  tuitionAmount?: number | null;
  weeklySessionCount?: number | null;
  pricePerSession?: number | null;
  sessionBalance?: number | null;
};

export type StudentVM = StudentTuitionTarget & {
  attnId: string;
  /** 저장 학년(수정 시트 기준값) */
  grade: GradeCode | null;
  gradeYear: number | null;
  /** 올해 표시 학년 — 고3을 넘으면 졸업 */
  displayGrade: DisplayGrade | null;
  gradeLabel: string;
  school: string;
  /** 학생 본인 번호 */
  phone: string;
  status: StudentStatus;
  firstAttendedOn: string | null;
  guardians: StudentGuardian[];
  parentUids: string[];
  classIds: string[];
  teacherUids: string[];
  createdAtMs: number;
  tuitionReminderConfirmed: boolean;
  absenceDeductionPerDay: number | null;
};

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

function intInRange(raw: unknown, min: number, max: number): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max ? raw : null;
}

function millis(raw: unknown): number {
  return raw && typeof raw === "object" && "toMillis" in raw && typeof raw.toMillis === "function"
    ? (raw.toMillis as () => number)()
    : 0;
}

/** 저장된 보호자 목록 — 서버 `readGuardians`와 같은 해석 */
export function readStudentGuardians(raw: unknown): StudentGuardian[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): StudentGuardian[] => {
    const g = x as Record<string, unknown> | null;
    if (!g || typeof g.id !== "string" || typeof g.phone !== "string") return [];
    return [{
      id: g.id,
      relationId: typeof g.relationId === "string" && g.relationId ? g.relationId : null,
      name: typeof g.name === "string" && g.name ? g.name : null,
      phone: g.phone,
      isPrimary: g.isPrimary === true,
      linkedParentUid: typeof g.linkedParentUid === "string" && g.linkedParentUid ? g.linkedParentUid : null,
    }];
  });
}

export function docToStudent(id: string, data: Record<string, unknown>): StudentVM {
  const grade = isGradeCode(data.grade) ? data.grade : null;
  const gradeYear = typeof data.gradeYear === "number" && Number.isInteger(data.gradeYear) ? data.gradeYear : null;
  const shown = displayGrade(grade, gradeYear);
  const rawType = data.tuitionType;
  return {
    id,
    attnId: typeof data.attnId === "string" ? data.attnId : "",
    name: typeof data.name === "string" ? data.name : "",
    grade,
    gradeYear,
    displayGrade: shown,
    gradeLabel: gradeLabel(shown),
    school: typeof data.school === "string" ? data.school : "",
    phone: typeof data.phone === "string" ? data.phone : "",
    status: normalizeStudentStatus(data.status),
    firstAttendedOn: typeof data.firstAttendedOn === "string" && data.firstAttendedOn ? data.firstAttendedOn : null,
    guardians: readStudentGuardians(data.guardians),
    parentUids: stringList(data.parentUids),
    classIds: stringList(data.classIds),
    teacherUids: stringList(data.teacherUids),
    createdAtMs: millis(data.createdAt),
    tuitionType: rawType === "monthly_fixed" || rawType === "session_based" ? rawType : null,
    tuitionDueDayOfMonth: intInRange(data.tuitionDueDayOfMonth, 1, 31),
    tuitionAmount: typeof data.tuitionAmount === "number" ? data.tuitionAmount : null,
    weeklySessionCount: intInRange(data.weeklySessionCount, 1, 7),
    pricePerSession: typeof data.pricePerSession === "number" && data.pricePerSession >= 0 ? data.pricePerSession : null,
    sessionBalance:
      typeof data.sessionBalance === "number" && Number.isInteger(data.sessionBalance) ? data.sessionBalance : null,
    tuitionReminderConfirmed: millis(data.tuitionReminderConfirmedAt) > 0,
    absenceDeductionPerDay:
      typeof data.absenceDeductionPerDay === "number" && data.absenceDeductionPerDay > 0
        ? data.absenceDeductionPerDay
        : null,
  };
}

/** 대표 보호자 — 지정이 없으면 첫 번째 */
export function primaryGuardian(s: { guardians: readonly StudentGuardian[] }): StudentGuardian | null {
  return s.guardians.find((g) => g.isPrimary) ?? s.guardians[0] ?? null;
}

/** 보호자 관계 표시 — 없거나 지운 선택지면 "관계 미지정" */
export function guardianRelationLabel(relationId: string | null, relations: readonly AcademyOptionItem[]): string {
  return (relationId && relations.find((r) => r.id === relationId)?.label) || "관계 미지정";
}

/** 이름 오름차순(가나다) */
export function compareStudentsByName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, "ko");
}
