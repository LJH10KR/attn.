/**
 * 원생 상태·학년 판단 — `src/lib/academy/student-profile.ts`(화면)와 같은 내용이므로 함께 맞출 것.
 *
 * 상태 제외(퇴원·휴원·미등록)는 원비·회차 리마인더, 출결 알림, 키오스크에서 이 함수들로만 판단한다.
 * 3·4단계에서 출결·청구를 새로 만들 때도 `isActiveStudent`·`isBillableStudent`를 쓸 것.
 */

export const STUDENT_STATUSES = ["enrolled", "prospect", "withdrawn", "on_leave"] as const;

export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export const STUDENT_STATUS_LABELS: Record<StudentStatus, string> = {
  enrolled: "재원",
  prospect: "미등록",
  withdrawn: "퇴원",
  on_leave: "휴원",
};

export function isStudentStatus(raw: unknown): raw is StudentStatus {
  return typeof raw === "string" && (STUDENT_STATUSES as readonly string[]).includes(raw);
}

/** 값이 없거나 모르는 값이면 재원으로 읽는다(서버는 항상 상태를 쓴다) */
export function normalizeStudentStatus(raw: unknown): StudentStatus {
  return isStudentStatus(raw) ? raw : "enrolled";
}

/** 재원 — 출결 알림·키오스크·출석 버튼 대상 */
export function isActiveStudent(student: { status?: unknown }): boolean {
  return normalizeStudentStatus(student.status) === "enrolled";
}

/** 재원 — 원비·회차 리마인더, 학부모 앱 결제 대상(휴원 중 청구 중단) */
export function isBillableStudent(student: { status?: unknown }): boolean {
  return normalizeStudentStatus(student.status) === "enrolled";
}

export const GRADE_CODES = [
  "preschool",
  "e1", "e2", "e3", "e4", "e5", "e6",
  "m1", "m2", "m3",
  "h1", "h2", "h3",
  "adult",
] as const;

export type GradeCode = (typeof GRADE_CODES)[number];

/** 저장 학년 + 경과 연도 결과 — 고3을 넘으면 졸업(상태는 바꾸지 않음) */
export type DisplayGrade = GradeCode | "graduated";

/** 해마다 한 칸씩 올라가는 학년 — 미취학·성인·기타는 자동 진급하지 않는다 */
const PROGRESSION: readonly GradeCode[] = [
  "e1", "e2", "e3", "e4", "e5", "e6", "m1", "m2", "m3", "h1", "h2", "h3",
];

const GRADE_LABELS: Record<DisplayGrade, string> = {
  preschool: "미취학",
  e1: "초1", e2: "초2", e3: "초3", e4: "초4", e5: "초5", e6: "초6",
  m1: "중1", m2: "중2", m3: "중3",
  h1: "고1", h2: "고2", h3: "고3",
  adult: "성인·기타",
  graduated: "졸업",
};

export function isGradeCode(raw: unknown): raw is GradeCode {
  return typeof raw === "string" && (GRADE_CODES as readonly string[]).includes(raw);
}

/** 서울 기준 연도 — 진급 기준일은 1월 1일 */
export function kstYear(now: Date = new Date()): number {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).getUTCFullYear();
}

/** 표시 학년 = 저장 학년 + (올해 − 기준 연도). 저장 값이 없으면 null */
export function displayGrade(
  grade: unknown,
  gradeYear: unknown,
  nowYear: number = kstYear(),
): DisplayGrade | null {
  if (!isGradeCode(grade)) return null;
  const idx = PROGRESSION.indexOf(grade);
  if (idx < 0) return grade;
  const base = typeof gradeYear === "number" && Number.isInteger(gradeYear) ? gradeYear : nowYear;
  const next = idx + Math.max(0, nowYear - base);
  return next < PROGRESSION.length ? PROGRESSION[next]! : "graduated";
}

export function gradeLabel(grade: DisplayGrade | null): string {
  return grade ? GRADE_LABELS[grade] : "";
}
