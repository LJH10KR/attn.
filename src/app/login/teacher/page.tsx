import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "../login-form";
import { LoginSessionAutoRedirect } from "../login-session-auto-redirect";
import { LoginSuspenseFallback } from "../login-suspense-fallback";

export const metadata: Metadata = {
  title: "선생님 로그인 — attn.",
  description: "attn. 선생님 로그인",
};

export default function TeacherLoginPage() {
  return (
    <Suspense fallback={<LoginSuspenseFallback />}>
      <LoginSessionAutoRedirect />
      <LoginForm fixedRole="teacher" />
    </Suspense>
  );
}
