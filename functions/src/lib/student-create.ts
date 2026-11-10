import { FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { deriveGuardianFields, type Guardian } from "./student-guardians";
import { displayGrade, isGradeCode, type GradeCode, type StudentStatus } from "./student-profile";

/**
 * 원생 만들기 공용(2-M) — 원생 1명 저장(`saveStudent`)과 여러 명 저장(`createStudentsBulk`)이
 * 같은 검증·파생 필드(`guardianPhones`·`parentUids`·`classIds`·`teacherUids`)로 학생 문서를 만든다.
 * 학생 문서가 생기면 학생 트리거(`onAcademyStudentParentLinksWritten`)가 새 보호자 번호로 자동 연결(2-L ★3)을 돈다.
 */

export const STUDENT_NAME_MAX = 40;
export const STUDENT_SCHOOL_MAX = 40;

/** 이름 1~40자 */
export function parseStudentName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > STUDENT_NAME_MAX) {
    throw new HttpsError("invalid-argument", `이름을 1~${STUDENT_NAME_MAX}자로 입력해 주세요.`);
  }
  return name;
}

/** 학교 40자 이하(빈 값 허용) */
export function parseStudentSchool(raw: unknown): string {
  const school = typeof raw === "string" ? raw.trim() : "";
  if (school.length > STUDENT_SCHOOL_MAX) {
    throw new HttpsError("invalid-argument", `학교는 ${STUDENT_SCHOOL_MAX}자 이하로 입력해 주세요.`);
  }
  return school;
}

/**
 * 화면은 "지금 보이는 학년"을 보낸다. 저장 값의 표시 학년과 같으면 저장 값(기준 연도 포함)을 그대로 두고,
 * 바뀌었으면 보낸 학년을 올해 기준으로 저장한다. 졸업은 저장 값이 졸업으로 보일 때만 그대로 받는다.
 */
export function resolveGrade(
  raw: unknown,
  stored: { grade: unknown; gradeYear: unknown } | null,
  nowYear: number,
): { grade: GradeCode; gradeYear: number } {
  if (stored && isGradeCode(stored.grade) && typeof stored.gradeYear === "number") {
    if (raw === displayGrade(stored.grade, stored.gradeYear, nowYear)) {
      return { grade: stored.grade, gradeYear: stored.gradeYear };
    }
  }
  if (!isGradeCode(raw)) {
    throw new HttpsError("invalid-argument", "학년을 선택해 주세요.");
  }
  return { grade: raw, gradeYear: nowYear };
}

/** 새 학생 문서(`tx.create`/`ref.create`) — `attnId`는 호출 측이 학생 번호로 만든다 */
export function newStudentDocFields(params: {
  attnId: string;
  profile: { name: string; school: string | null; phone: string | null; firstAttendedOn: string | null };
  grade: { grade: GradeCode; gradeYear: number };
  status: StudentStatus;
  guardians: Guardian[];
  callerUid: string;
}): Record<string, unknown> {
  return {
    attnId: params.attnId,
    ...params.profile,
    ...params.grade,
    status: params.status,
    statusChangedAt: FieldValue.serverTimestamp(),
    guardians: params.guardians,
    ...deriveGuardianFields(params.guardians),
    classIds: [],
    teacherUids: [],
    createdByUid: params.callerUid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}
