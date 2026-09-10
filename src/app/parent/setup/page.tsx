"use client";

import { MemberFirstLoginForm } from "@/components/auth/member-first-login-form";

export default function ParentSetupPage() {
  return (
    <div className="min-h-[100dvh] bg-background px-4 py-10 flex flex-col items-center justify-center">
      <div className="glass-card-hero w-full max-w-[400px] p-8">
        <h1 className="text-center text-xl font-semibold text-foreground">비밀번호 설정</h1>
        <p className="mt-1 text-center text-xs text-neutral-500">학부모 · attn.</p>
        <div className="mt-6">
          <MemberFirstLoginForm role="parent" />
        </div>
      </div>
    </div>
  );
}
