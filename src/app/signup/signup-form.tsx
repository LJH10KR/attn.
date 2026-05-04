"use client";

import { FirebaseError } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { GoogleMark } from "@/components/auth/google-mark";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { upsertOwnerProfile } from "@/lib/firebase/owner-profile";

function signupErrorMessage(code: string): string {
  switch (code) {
    case "auth/email-already-in-use":
      return "이미 사용 중인 이메일입니다. 로그인해 주세요.";
    case "auth/invalid-email":
      return "이메일 형식을 확인해 주세요.";
    case "auth/weak-password":
      return "비밀번호는 8자 이상으로 설정해 주세요.";
    case "auth/popup-closed-by-user":
      return "로그인 창이 닫혔습니다.";
    case "auth/network-request-failed":
      return "네트워크 오류입니다. 연결을 확인해 주세요.";
    default:
      return "회원가입에 실패했습니다. 다시 시도해 주세요.";
  }
}

export function SignupForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = isFirebaseConfigured();

  const onEmailSignup = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!configured) {
        setError("Firebase 환경 변수를 먼저 설정해 주세요.");
        return;
      }
      const em = email.trim();
      if (!em || !password) {
        setError("이메일과 비밀번호를 입력해 주세요.");
        return;
      }
      if (password.length < 8) {
        setError("비밀번호는 8자 이상이어야 합니다.");
        return;
      }
      if (password !== password2) {
        setError("비밀번호가 서로 일치하지 않습니다.");
        return;
      }
      setBusy(true);
      try {
        const auth = getFirebaseAuth();
        await createUserWithEmailAndPassword(auth, em, password);
        const fn = httpsCallable(getFirebaseFunctions(), "sendOwnerSignupVerificationEmail");
        await fn({});
        router.replace("/verify-email");
      } catch (err) {
        const code = err instanceof FirebaseError ? err.code : "";
        setError(signupErrorMessage(code));
      } finally {
        setBusy(false);
      }
    },
    [configured, email, password, password2, router],
  );

  const onGoogleSignup = useCallback(async () => {
    setError(null);
    if (!configured) {
      setError("Firebase 환경 변수를 먼저 설정해 주세요.");
      return;
    }
    setBusy(true);
    try {
      const auth = getFirebaseAuth();
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);
      /**
       * Google은 로그인만 해도 Auth 계정이 생깁니다. 기존에는 isNewUser가 아니면
       * Firestore 오너 문서 없이 로그인으로 보내 교착이 났음 → 항상 오너 프로필을 맞춤.
       */
      await upsertOwnerProfile(result.user);
      router.replace("/owner");
    } catch (err) {
      const code = err instanceof FirebaseError ? err.code : "";
      setError(signupErrorMessage(code));
    } finally {
      setBusy(false);
    }
  }, [configured, router]);

  return (
    <div className="min-h-[100dvh] bg-background px-4 py-10 flex flex-col items-center justify-center pb-[max(2rem,env(safe-area-inset-bottom))]">
      {!configured ? (
        <p className="mb-4 max-w-md rounded-2xl border border-amber-200/80 bg-amber-50/90 px-4 py-3 text-center text-sm text-amber-950 backdrop-blur-sm">
          <code className="font-mono text-xs">.env.local</code>에{" "}
          <code className="font-mono text-xs">NEXT_PUBLIC_FIREBASE_*</code> 값을
          넣어 주세요.
        </p>
      ) : null}

      <div
        className="glass-card-hero w-full max-w-[400px] p-8"
        style={{ WebkitBackdropFilter: "blur(24px) saturate(1.2)" }}
      >
        <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">
          회원가입
        </h1>
        <p className="mt-2 text-center text-xs text-neutral-500">
          attn. · 학원 오너
        </p>

        <div className="mt-4 flex justify-center">
          <span className="rounded-full bg-white/60 px-3 py-1 text-xs font-medium text-neutral-700 ring-1 ring-black/5">
            오너
          </span>
        </div>

        {error ? (
          <p
            className="mt-5 rounded-2xl bg-red-500/10 px-3 py-2.5 text-center text-sm text-red-800 ring-1 ring-red-500/15"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <form className="mt-6 space-y-4" onSubmit={onEmailSignup}>
          <div>
            <label
              className="mb-1.5 block text-xs font-medium text-neutral-600"
              htmlFor="signup-email"
            >
              이메일
            </label>
            <input
              id="signup-email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3.5 text-foreground shadow-inner shadow-white/40 outline-none focus:border-[#4a90e2]/50 focus:bg-white/70 focus:shadow-[0_0_0_3px_rgba(74,144,226,0.18)]"
              placeholder="name@example.com"
            />
          </div>
          <div>
            <label
              className="mb-1.5 block text-xs font-medium text-neutral-600"
              htmlFor="signup-password"
            >
              비밀번호
            </label>
            <input
              id="signup-password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3.5 text-foreground shadow-inner shadow-white/40 outline-none focus:border-[#4a90e2]/50 focus:bg-white/70 focus:shadow-[0_0_0_3px_rgba(74,144,226,0.18)]"
              placeholder="8자 이상"
            />
          </div>
          <div>
            <label
              className="mb-1.5 block text-xs font-medium text-neutral-600"
              htmlFor="signup-password2"
            >
              비밀번호 확인
            </label>
            <input
              id="signup-password2"
              name="password2"
              type="password"
              autoComplete="new-password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3.5 text-foreground shadow-inner shadow-white/40 outline-none focus:border-[#4a90e2]/50 focus:bg-white/70 focus:shadow-[0_0_0_3px_rgba(74,144,226,0.18)]"
            />
          </div>
          <button
            type="submit"
            disabled={busy || !configured}
            className="mt-2 w-full rounded-2xl bg-[#222] dark:bg-neutral-100 py-3.5 text-[15px] font-medium text-white dark:text-neutral-950 shadow-[0_8px_24px_rgba(0,0,0,0.18)] transition hover:bg-[#333] dark:hover:bg-white active:scale-[0.99] disabled:opacity-50"
          >
            {busy ? "처리 중…" : "가입 및 인증 메일 받기"}
          </button>
        </form>

        <div className="my-7 flex items-center gap-3">
          <span className="h-px flex-1 bg-gradient-to-r from-transparent via-neutral-300 to-neutral-300" />
          <span className="shrink-0 text-[11px] text-neutral-500">또는</span>
          <span className="h-px flex-1 bg-gradient-to-l from-transparent via-neutral-300 to-neutral-300" />
        </div>

        <button
          type="button"
          disabled={busy || !configured}
          onClick={onGoogleSignup}
          className="flex w-full items-center justify-center gap-3 rounded-2xl border border-neutral-300/70 bg-white/60 dark:border-white/12 dark:bg-white/10 py-3.5 text-[15px] font-medium text-foreground shadow-sm backdrop-blur-md transition hover:bg-white/85 active:scale-[0.99] disabled:opacity-50"
        >
          <GoogleMark />
          Google로 오너 가입
        </button>

        <p className="mt-6 text-center text-xs leading-relaxed text-neutral-500">
          이메일 가입 시 메일함의 링크로 인증을 완료한 뒤 로그인할 수 있습니다.
        </p>

        <p className="mt-4 text-center text-sm text-neutral-600">
          이미 계정이 있으신가요?{" "}
          <Link
            href="/login"
            className="font-medium text-[#4a90e2] underline-offset-2 hover:underline"
          >
            로그인
          </Link>
        </p>
      </div>

      {/* <p className="mt-8 text-center text-xs text-neutral-500">
        <Link href="/" className="underline-offset-2 hover:underline">
          홈으로
        </Link>
      </p> */}
    </div>
  );
}
