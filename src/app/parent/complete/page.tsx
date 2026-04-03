import type { Metadata } from "next";
import { Suspense } from "react";
import { ParentCompleteForm } from "./parent-complete-form";

export const metadata: Metadata = {
  title: "학부모 등록 완료 · attn.",
  robots: { index: false, follow: false },
};

export default function ParentCompletePage() {
  return (
    <div className="min-h-[100dvh] bg-[#f2f1eb] px-4 py-12 flex flex-col items-center justify-center">
      <div className="w-full max-w-md rounded-[1.75rem] border border-white/70 bg-[rgba(236,235,228,0.55)] p-8 shadow-lg backdrop-blur-xl">
        <h1 className="text-lg font-semibold text-[#111]">학부모 초청</h1>
        <Suspense fallback={<p className="mt-4 text-sm text-neutral-500">불러오는 중…</p>}>
          <div className="mt-4">
            <ParentCompleteForm />
          </div>
        </Suspense>
      </div>
    </div>
  );
}
