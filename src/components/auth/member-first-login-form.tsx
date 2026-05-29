"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";

type MemberFirstLoginFormProps = {
  role: "teacher" | "parent";
};

function errorMessage(err: FirebaseError): string {
  switch (err.code) {
    case "functions/invalid-argument":
      return err.message || "비밀번호를 확인해 주세요.";
    case "functions/unauthenticated":
      return "로그인이 필요합니다.";
    default:
      return err.message || "요청에 실패했습니다.";
  }
}

export function MemberFirstLoginForm({ role }: MemberFirstLoginFormProps) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (password.length < 6) {
        setError("비밀번호는 6자 이상이어야 합니다.");
        return;
      }
      if (password !== password2) {
        setError("비밀번호가 서로 일치하지 않습니다.");
        return;
      }
      setBusy(true);
      try {
        const fn = httpsCallable(getFirebaseFunctions(), "completeMemberFirstLogin");
        await fn({ newPassword: password });
        router.replace(role === "teacher" ? "/teacher" : "/parent");
      } catch (err) {
        if (err instanceof FirebaseError) {
          setError(errorMessage(err));
        } else {
          setError("요청에 실패했습니다.");
        }
      } finally {
        setBusy(false);
      }
    },
    [password, password2, role, router],
  );

  const label = role === "teacher" ? "선생님" : "학부모";

  return (
    <form className="space-y-4" onSubmit={(e) => void onSubmit(e)}>
      <p className="text-sm text-neutral-700">
        최초 로그인입니다. <strong>{label}</strong> 계정 비밀번호를 새로 설정해 주세요. 설정이
        완료되면 바로 이용할 수 있습니다.
      </p>
      {error ? (
        <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-600" htmlFor="new-pw">
          새 비밀번호
        </label>
        <input
          id="new-pw"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50"
        />
      </div>
      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-600" htmlFor="new-pw2">
          새 비밀번호 확인
        </label>
        <input
          id="new-pw2"
          type="password"
          autoComplete="new-password"
          value={password2}
          onChange={(e) => setPassword2(e.target.value)}
          className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50"
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-950"
      >
        {busy ? "저장 중…" : "비밀번호 설정 완료"}
      </button>
      <p className="text-center text-xs text-neutral-500">
        <Link href={`/login/${role}`} className="text-[#4a90e2] hover:underline">
          로그인 화면으로
        </Link>
      </p>
    </form>
  );
}
