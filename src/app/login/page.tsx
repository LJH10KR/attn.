import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "로그인 — attn.",
  description: "attn. 서비스 로그인",
};

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[100dvh] items-center justify-center bg-[#f2f1eb]">
          <span className="text-sm text-neutral-500">로딩 중…</span>
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
