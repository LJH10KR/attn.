import type { Metadata } from "next";
import { Suspense } from "react";
import { ResetPasswordScreen } from "@/components/auth/account-recovery-screens";
import { LoginSuspenseFallback } from "../login-suspense-fallback";

export const metadata: Metadata = {
  title: "비밀번호 찾기 — attn.",
  description: "attn. 직원·학부모 비밀번호 찾기",
};

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<LoginSuspenseFallback />}>
      <ResetPasswordScreen />
    </Suspense>
  );
}
