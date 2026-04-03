"use client";

import { FirebaseError } from "firebase/app";
import {
  GoogleAuthProvider,
  sendPasswordResetEmail,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithPopup,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { GoogleMark } from "@/components/auth/google-mark";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";

export type LoginRole = "owner" | "academy" | "teacher" | "parent";

const ROLES: { id: LoginRole; label: string; hint: string }[] = [
  { id: "owner", label: "오너", hint: "학원 등록·운영" },
  { id: "academy", label: "학원", hint: "포털 로그인" },
  { id: "teacher", label: "선생님", hint: "학원 소속" },
  { id: "parent", label: "학부모", hint: "알림·출석" },
];

function authErrorMessage(code: string, role: LoginRole): string {
  switch (code) {
    case "auth/invalid-email":
      return "이메일 형식을 확인해 주세요.";
    case "auth/user-disabled":
      if (role === "teacher") {
        return "선생님 등록 대기(pending) 상태라 로그인할 수 없습니다. 학원에서 활성 처리 후 다시 시도해 주세요.";
      }
      return "이 계정은 현재 로그인할 수 없습니다. 학원에서 승인·활성 처리가 끝난 뒤 다시 시도하거나 문의해 주세요.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "이메일 또는 비밀번호가 올바르지 않습니다.";
    case "auth/too-many-requests":
      return "시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.";
    case "auth/popup-closed-by-user":
      return "로그인 창이 닫혔습니다.";
    case "auth/network-request-failed":
      return "네트워크 오류입니다. 연결을 확인해 주세요.";
    default:
      return "로그인에 실패했습니다. 다시 시도해 주세요.";
  }
}

function functionsErrorMessage(err: FirebaseError): string {
  switch (err.code) {
    case "functions/permission-denied":
      return "비밀번호가 올바르지 않습니다.";
    case "functions/not-found":
      return "학원을 찾을 수 없습니다.";
    case "functions/failed-precondition":
      return "학원 로그인이 아직 설정되지 않았습니다. 오너에게 문의해 주세요.";
    case "functions/invalid-argument":
      return "학원 ID와 비밀번호를 입력해 주세요.";
    default:
      return err.message || "학원 로그인에 실패했습니다. 다시 시도해 주세요.";
  }
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [role, setRole] = useState<LoginRole>("owner");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [academyId, setAcademyId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const configured = isFirebaseConfigured();

  useEffect(() => {
    const r = searchParams.get("role");
    if (r === "teacher" || r === "parent" || r === "owner" || r === "academy") {
      setRole(r);
    }
    const msg = searchParams.get("msg");
    if (msg === "existing_account") {
      setBanner("이미 가입된 Google 계정입니다. 로그인해 주세요.");
    } else if (msg === "owner_only") {
      setBanner("오너 대시보드는 로그인 후 이용할 수 있습니다.");
    } else {
      setBanner(null);
    }
  }, [searchParams]);

  const checkTeacherActivationOrRedirect = useCallback(
    async (): Promise<boolean> => {
      // 선생님은 로그인 성공 후에도 "active 상태"가 아니면 접근을 막아야 합니다.
      const functions = getFirebaseFunctions();
      const fn = httpsCallable(functions, "getTeacherActivationState");
      const res = await fn({});
      const data = res.data as {
        anyActive?: boolean;
        primaryStatus?: string | null;
        primaryAcademyId?: string | null;
      };

      if (data?.anyActive) return true;

      const state = data?.primaryStatus ?? "unknown";
      const academyId = data?.primaryAcademyId ?? "";
      const q = new URLSearchParams();
      q.set("state", state);
      if (academyId) q.set("academyId", academyId);
      router.replace(`/teacher/session?${q.toString()}`);
      return false;
    },
    [router],
  );
  const showEmailAuth = role === "owner" || role === "teacher" || role === "parent";
  const showGoogle = showEmailAuth;
  const showAcademyFields = role === "academy";

  const onEmailLogin = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setResetSent(false);
      if (!configured) {
        setError("Firebase 환경 변수를 먼저 설정해 주세요.");
        return;
      }
      if (!email.trim() || !password) {
        setError("이메일과 비밀번호를 입력해 주세요.");
        return;
      }
      setBusy(true);
      try {
        const auth = getFirebaseAuth();
        const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
        if (showEmailAuth && !cred.user.emailVerified) {
          router.replace("/verify-email");
          return;
        }
        if (role === "teacher") {
          const ok = await checkTeacherActivationOrRedirect();
          if (!ok) return;
        }
        router.replace(role === "owner" ? "/owner" : "/");
      } catch (err) {
        const code = err instanceof FirebaseError ? err.code : "";
        setError(authErrorMessage(code, role));
      } finally {
        setBusy(false);
      }
    },
    [checkTeacherActivationOrRedirect, configured, email, password, router, role, showEmailAuth],
  );

  const onGoogleLogin = useCallback(async () => {
    setError(null);
    setResetSent(false);
    if (!configured) {
      setError("Firebase 환경 변수를 먼저 설정해 주세요.");
      return;
    }
    setBusy(true);
    try {
      const auth = getFirebaseAuth();
      const provider = new GoogleAuthProvider();
      const cred = await signInWithPopup(auth, provider);
      if (!cred.user.emailVerified) {
        router.replace("/verify-email");
        return;
      }
      if (role === "teacher") {
        const ok = await checkTeacherActivationOrRedirect();
        if (!ok) return;
      }
      router.replace(role === "owner" ? "/owner" : "/");
    } catch (err) {
      const code = err instanceof FirebaseError ? err.code : "";
      setError(authErrorMessage(code, role));
    } finally {
      setBusy(false);
    }
  }, [checkTeacherActivationOrRedirect, configured, role, router]);

  const onAcademyLogin = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!configured) {
        setError("Firebase 환경 변수를 먼저 설정해 주세요.");
        return;
      }
      if (!academyId.trim() || !password) {
        setError("학원 ID와 비밀번호를 입력해 주세요.");
        return;
      }
      setBusy(true);
      try {
        const auth = getFirebaseAuth();
        const functions = getFirebaseFunctions();
        const signIn = httpsCallable(functions, "signInAcademy");
        const result = await signIn({
          academyId: academyId.trim().toLowerCase(),
          password,
        });
        const data = result.data as { customToken?: string };
        if (!data?.customToken) {
          setError("학원 로그인 응답이 올바르지 않습니다.");
          return;
        }
        await signInWithCustomToken(auth, data.customToken);
        router.replace("/academy");
      } catch (err) {
        if (err instanceof FirebaseError) {
          setError(functionsErrorMessage(err));
        } else {
          setError("학원 로그인에 실패했습니다.");
        }
      } finally {
        setBusy(false);
      }
    },
    [academyId, configured, password, router],
  );

  const onPasswordReset = useCallback(async () => {
    setError(null);
    setResetSent(false);
    if (!configured) {
      setError("Firebase 환경 변수를 먼저 설정해 주세요.");
      return;
    }
    if (!email.trim()) {
      setError("비밀번호 재설정을 위해 이메일을 입력해 주세요.");
      return;
    }
    setBusy(true);
    try {
      const auth = getFirebaseAuth();
      await sendPasswordResetEmail(auth, email.trim());
      setResetSent(true);
    } catch (err) {
      const code = err instanceof FirebaseError ? err.code : "";
      setError(authErrorMessage(code, role));
    } finally {
      setBusy(false);
    }
  }, [configured, email, role]);

  return (
    <div className="min-h-[100dvh] bg-[#f2f1eb] px-4 py-10 flex flex-col items-center justify-center pb-[max(2rem,env(safe-area-inset-bottom))]">
      {!configured ? (
        <p className="mb-4 max-w-md rounded-2xl border border-amber-200/80 bg-amber-50/90 px-4 py-3 text-center text-sm text-amber-950 backdrop-blur-sm">
          <code className="font-mono text-xs">.env.example</code>을 참고해{" "}
          <code className="font-mono text-xs">.env.local</code>에{" "}
          <code className="font-mono text-xs">NEXT_PUBLIC_FIREBASE_*</code> 값을
          넣어 주세요.
        </p>
      ) : null}

      <div
        className="w-full max-w-[400px] rounded-[2.5rem] border border-white/70 bg-[rgba(236,235,228,0.45)] p-8 shadow-[0_24px_80px_-20px_rgba(0,0,0,0.14),inset_0_1px_0_rgba(255,255,255,0.85)] backdrop-blur-2xl backdrop-saturate-150"
        style={{ WebkitBackdropFilter: "blur(24px) saturate(1.2)" }}
      >
        <h1 className="text-center text-2xl font-semibold tracking-tight text-[#111]">
          로그인
        </h1>

        <p className="mt-2 text-center text-xs text-neutral-500">attn.</p>

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {ROLES.map((r) => (
            <button
              key={r.id}
              type="button"
              disabled={busy}
              onClick={() => {
                setRole(r.id);
                setError(null);
                setResetSent(false);
              }}
              className={`rounded-full px-3.5 py-2 text-xs font-medium transition-all ${
                role === r.id
                  ? "bg-white/75 text-[#111] shadow-[0_4px_20px_rgba(0,0,0,0.08)] ring-1 ring-black/10"
                  : "bg-white/35 text-neutral-600 ring-1 ring-black/5 hover:bg-white/55"
              } disabled:opacity-50`}
            >
              <span className="block leading-tight">{r.label}</span>
              <span className="mt-0.5 block text-[10px] font-normal text-neutral-500">
                {r.hint}
              </span>
            </button>
          ))}
        </div>

        {banner ? (
          <p className="mt-5 rounded-2xl bg-sky-500/10 px-3 py-2.5 text-center text-sm text-sky-950 ring-1 ring-sky-500/20">
            {banner}
          </p>
        ) : null}
        {error ? (
          <p
            className="mt-5 rounded-2xl bg-red-500/10 px-3 py-2.5 text-center text-sm text-red-800 ring-1 ring-red-500/15"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        {resetSent ? (
          <p className="mt-5 rounded-2xl bg-emerald-500/10 px-3 py-2.5 text-center text-sm text-emerald-900 ring-1 ring-emerald-500/15">
            비밀번호 재설정 메일을 보냈습니다. 메일함을 확인해 주세요.
          </p>
        ) : null}

        {showAcademyFields ? (
          <form className="mt-6 space-y-4" onSubmit={onAcademyLogin}>
            <div>
              <label
                className="mb-1.5 block text-xs font-medium text-neutral-600"
                htmlFor="academy-id"
              >
                학원 ID
              </label>
              <input
                id="academy-id"
                name="academyId"
                autoComplete="username"
                value={academyId}
                onChange={(e) => setAcademyId(e.target.value)}
                className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3.5 text-[#111] shadow-inner shadow-white/40 outline-none ring-0 transition placeholder:text-neutral-400 focus:border-[#4a90e2]/50 focus:bg-white/70 focus:shadow-[0_0_0_3px_rgba(74,144,226,0.18)]"
                placeholder="오너가 설정한 학원 로그인 ID"
              />
            </div>
            <div>
              <label
                className="mb-1.5 block text-xs font-medium text-neutral-600"
                htmlFor="academy-password"
              >
                비밀번호
              </label>
              <input
                id="academy-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3.5 text-[#111] shadow-inner shadow-white/40 outline-none focus:border-[#4a90e2]/50 focus:bg-white/70 focus:shadow-[0_0_0_3px_rgba(74,144,226,0.18)]"
                placeholder="포털 비밀번호"
              />
            </div>
            <button
              type="submit"
              disabled={busy || !configured}
              className="mt-2 w-full rounded-2xl bg-[#222] py-3.5 text-[15px] font-medium text-white shadow-[0_8px_24px_rgba(0,0,0,0.18)] transition hover:bg-[#333] active:scale-[0.99] disabled:opacity-50"
            >
              {busy ? "처리 중…" : "로그인"}
            </button>
          </form>
        ) : (
          <form className="mt-6 space-y-4" onSubmit={onEmailLogin}>
            <div>
              <label
                className="mb-1.5 block text-xs font-medium text-neutral-600"
                htmlFor="email"
              >
                이메일
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3.5 text-[#111] shadow-inner shadow-white/40 outline-none focus:border-[#4a90e2]/50 focus:bg-white/70 focus:shadow-[0_0_0_3px_rgba(74,144,226,0.18)]"
                placeholder="name@example.com"
              />
            </div>
            <div>
              <label
                className="mb-1.5 block text-xs font-medium text-neutral-600"
                htmlFor="password"
              >
                비밀번호
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3.5 text-[#111] shadow-inner shadow-white/40 outline-none focus:border-[#4a90e2]/50 focus:bg-white/70 focus:shadow-[0_0_0_3px_rgba(74,144,226,0.18)]"
              />
            </div>
            <button
              type="submit"
              disabled={busy || !configured}
              className="mt-2 w-full rounded-2xl bg-[#222] py-3.5 text-[15px] font-medium text-white shadow-[0_8px_24px_rgba(0,0,0,0.18)] transition hover:bg-[#333] active:scale-[0.99] disabled:opacity-50"
            >
              {busy ? "처리 중…" : "로그인"}
            </button>
          </form>
        )}

        {showGoogle ? (
          <>
            <div className="my-7 flex items-center gap-3">
              <span className="h-px flex-1 bg-gradient-to-r from-transparent via-neutral-300 to-neutral-300" />
              <span className="shrink-0 text-[11px] text-neutral-500">
                또는 다른 방식으로 로그인
              </span>
              <span className="h-px flex-1 bg-gradient-to-l from-transparent via-neutral-300 to-neutral-300" />
            </div>
            <button
              type="button"
              disabled={busy || !configured}
              onClick={onGoogleLogin}
              className="flex w-full items-center justify-center gap-3 rounded-2xl border border-neutral-300/70 bg-white/60 py-3.5 text-[15px] font-medium text-[#222] shadow-sm backdrop-blur-md transition hover:bg-white/85 active:scale-[0.99] disabled:opacity-50"
            >
              <GoogleMark />
              Google 계정으로 시작
            </button>
          </>
        ) : null}

        <div className="mt-8 space-y-2 text-center text-sm text-neutral-600">
          {showEmailAuth ? (
            <p>
              비밀번호를 잊으셨나요?{" "}
              <button
                type="button"
                disabled={busy || !configured}
                onClick={onPasswordReset}
                className="font-medium text-[#4a90e2] underline-offset-2 hover:underline disabled:opacity-50"
              >
                비밀번호 재설정
              </button>
            </p>
          ) : null}
          {showEmailAuth && role === "owner" ? (
            <p>
              오너 계정이 없으신가요?{" "}
              <Link
                href="/signup"
                className="font-medium text-[#4a90e2] underline-offset-2 hover:underline"
              >
                회원가입
              </Link>
            </p>
          ) : showEmailAuth ? (
            <p className="text-xs text-neutral-500">
              선생님·학부모 계정은 학원에서 안내에 따라 가입해 주세요.
            </p>
          ) : (
            <p className="text-xs text-neutral-500">
              학원 계정은 오너가 발급한 ID·비밀번호로만 로그인할 수 있습니다.
            </p>
          )}
        </div>
      </div>

      <p className="mt-8 text-center text-xs text-neutral-500">
        <Link href="/" className="underline-offset-2 hover:underline">
          홈으로
        </Link>
      </p>
    </div>
  );
}
