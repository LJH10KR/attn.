"use client";

import Link from "next/link";
import {
  LOGIN_ROLE_OPTIONS,
  loginPathForRole,
} from "@/lib/auth/login-routes";

export function LoginHub() {
  return (
    <div className="min-h-[100dvh] bg-background px-4 py-10 flex flex-col items-center justify-center pb-[max(2rem,env(safe-area-inset-bottom))]">
      <div
        className="glass-card-hero w-full max-w-[400px] p-8"
        style={{ WebkitBackdropFilter: "blur(24px) saturate(1.2)" }}
      >
        <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">
          로그인
        </h1>
        <p className="mt-2 text-center text-xs text-neutral-500">attn.</p>
        <p className="mt-4 text-center text-sm text-neutral-600">
          역할을 선택해 주세요
        </p>
        <ul className="mt-6 flex flex-col gap-3">
          {LOGIN_ROLE_OPTIONS.map((r) => (
            <li key={r.id}>
              <Link
                href={loginPathForRole(r.id)}
                className="block rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-4 text-left shadow-sm transition hover:bg-white/70 active:scale-[0.99] dark:border-white/12 dark:bg-white/[0.08]"
              >
                <span className="font-medium text-foreground">{r.label}</span>
                <span className="mt-1 block text-xs text-neutral-500">
                  {r.hint}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
