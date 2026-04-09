import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "../login-form";
import { LoginSessionAutoRedirect } from "../login-session-auto-redirect";
import { LoginSuspenseFallback } from "../login-suspense-fallback";

export const metadata: Metadata = {
  title: "오너 로그인 — attn.",
  description: "attn. 오너 로그인",
};

export default function OwnerLoginPage() {
  return (
    <Suspense fallback={<LoginSuspenseFallback />}>
      <LoginSessionAutoRedirect />
      <LoginForm fixedRole="owner" />
    </Suspense>
  );
}
