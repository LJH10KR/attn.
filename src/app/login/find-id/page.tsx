import type { Metadata } from "next";
import { Suspense } from "react";
import { FindLoginIdScreen } from "@/components/auth/account-recovery-screens";
import { LoginSuspenseFallback } from "../login-suspense-fallback";

export const metadata: Metadata = {
  title: "아이디 찾기 — attn.",
  description: "attn. 직원·학부모 아이디 찾기",
};

export default function FindLoginIdPage() {
  return (
    <Suspense fallback={<LoginSuspenseFallback />}>
      <FindLoginIdScreen />
    </Suspense>
  );
}
