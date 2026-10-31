import type { DisplayGrade } from "@/lib/academy/student-profile";
import { phoneMatchesSearch } from "@/lib/phone/kr-phone";

/** 원생 목록 필터 — 원생 관리 화면과 원생 다중 선택 목록이 같이 쓴다 */

export type GradeFilter = "all" | "preschool" | "elementary" | "middle" | "high" | "adult" | "graduated";

export const GRADE_FILTERS: { id: GradeFilter; label: string }[] = [
  { id: "all", label: "전체 학년" },
  { id: "preschool", label: "미취학" },
  { id: "elementary", label: "초등" },
  { id: "middle", label: "중등" },
  { id: "high", label: "고등" },
  { id: "adult", label: "성인·기타" },
  { id: "graduated", label: "졸업" },
];

export function gradeGroup(g: DisplayGrade | null): GradeFilter | null {
  if (!g) return null;
  if (g === "preschool" || g === "adult" || g === "graduated") return g;
  if (g.startsWith("e")) return "elementary";
  if (g.startsWith("m")) return "middle";
  return "high";
}

/** 이름·학교·학생/보호자 번호·보호자 이름 검색 — `q`는 소문자로 다듬은 값 */
export function studentMatchesSearch(
  s: {
    name: string;
    school: string;
    phone: string;
    guardians: readonly { phone: string; name: string | null }[];
  },
  q: string,
): boolean {
  if (!q) return true;
  return (
    s.name.toLowerCase().includes(q) ||
    s.school.toLowerCase().includes(q) ||
    phoneMatchesSearch(s.phone, q) ||
    s.guardians.some((g) => phoneMatchesSearch(g.phone, q) || (g.name ?? "").toLowerCase().includes(q))
  );
}
