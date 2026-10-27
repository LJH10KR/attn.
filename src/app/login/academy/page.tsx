import { redirect } from "next/navigation";

/** 학원 포털 공용 로그인 폐지 — 예전 주소로 들어오면 로그인 선택 화면으로 */
export default function AcademyLoginPage() {
  redirect("/login");
}
