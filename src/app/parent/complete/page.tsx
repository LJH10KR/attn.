import type { Metadata } from "next";
import { Suspense } from "react";
import { ParentCompleteForm } from "./parent-complete-form";

export const metadata: Metadata = {
  title: "학부모 등록 완료 · attn.",
  robots: { index: false, follow: false },
};

export default function ParentCompletePage() {
  return (
    <div className="min-h-[100dvh] bg-background px-4 py-12 flex flex-col items-center justify-center">
      <div className="glass-card-soft w-full max-w-md p-8 text-center">
        <h1 className="text-lg font-semibold text-foreground">학부모 초청</h1>
        <Suspense fallback={<p className="mt-4 text-sm text-neutral-500">불러오는 중…</p>}>
          <div className="mt-4">
            <ParentCompleteForm />
          </div>
        </Suspense>
      </div>
    </div>
  );
}
