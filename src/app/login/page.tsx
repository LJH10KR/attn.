import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { isKnownLoginRole } from "@/lib/auth/login-routes";
import { LoginHub } from "./login-hub";
import { LoginSessionAutoRedirect } from "./login-session-auto-redirect";
import { LoginSuspenseFallback } from "./login-suspense-fallback";

export const metadata: Metadata = {
  title: "로그인 — attn.",
  description: "attn. 서비스 로그인",
};

function first(
  v: string | string[] | undefined,
): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await searchParams) ?? {};
  const roleQ = first(sp.role);
  if (roleQ && isKnownLoginRole(roleQ)) {
    const q = new URLSearchParams();
    const msg = first(sp.msg);
    const stay = first(sp.stay);
    if (msg) q.set("msg", msg);
    if (stay) q.set("stay", stay);
    const qs = q.toString();
    redirect(`/login/${roleQ}${qs ? `?${qs}` : ""}`);
  }
  const msgOnly = first(sp.msg);
  if (msgOnly) {
    const q = new URLSearchParams();
    q.set("msg", msgOnly);
    const stay = first(sp.stay);
    if (stay) q.set("stay", stay);
    redirect(`/login/owner?${q.toString()}`);
  }

  return (
    <Suspense fallback={<LoginSuspenseFallback />}>
      <LoginSessionAutoRedirect />
      <LoginHub />
    </Suspense>
  );
}
