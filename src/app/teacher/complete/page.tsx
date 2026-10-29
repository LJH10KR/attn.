import { redirect } from "next/navigation";

/** 선생님 이메일 초청 폐지(초대 링크 `/join/staff`로 대체) — 예전 메일 링크는 로그인 화면으로 */
export default function TeacherCompletePage() {
  redirect("/login/teacher");
}
