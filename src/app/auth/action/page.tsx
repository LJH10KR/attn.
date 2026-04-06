import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthActionForm } from "./auth-action-form";

export const metadata: Metadata = {
  title: "계정 작업 · attn.",
  robots: { index: false, follow: false },
};

export default function AuthActionPage() {
  return (
    <div className="min-h-[100dvh] bg-background px-4 py-12 flex flex-col items-center justify-center">
      <div className="glass-card-soft w-full max-w-md p-8 text-center">
        <h1 className="text-lg font-semibold text-foreground">attn. 계정</h1>
        <Suspense
          fallback={<p className="mt-4 text-sm text-neutral-500">불러오는 중…</p>}
        >
          <AuthActionForm />
        </Suspense>
      </div>
    </div>
  );
}
