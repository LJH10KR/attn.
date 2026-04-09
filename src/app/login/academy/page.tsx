import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "../login-form";
import { LoginSessionAutoRedirect } from "../login-session-auto-redirect";
import { LoginSuspenseFallback } from "../login-suspense-fallback";

export const metadata: Metadata = {
  title: "학원 로그인 — attn.",
  description: "attn. 학원 포털 로그인",
};

export default function AcademyLoginPage() {
  return (
    <Suspense fallback={<LoginSuspenseFallback />}>
      <LoginSessionAutoRedirect />
      <LoginForm fixedRole="academy" />
    </Suspense>
  );
}
