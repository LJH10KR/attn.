"use client";

import { FirebaseError } from "firebase/app";
import type { User } from "firebase/auth";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { GoogleMark } from "@/components/auth/google-mark";
import {
  LOGIN_ROLE_OPTIONS,
  type LoginRole,
} from "@/lib/auth/login-routes";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import {
  getFirebaseAuth,
  getFirebaseFunctions,
} from "@/lib/firebase/client-app";
import { upsertOwnerProfile } from "@/lib/firebase/owner-profile";

export type { LoginRole } from "@/lib/auth/login-routes";

const ROLES = LOGIN_ROLE_OPTIONS;

function authErrorMessage(code: string, role: LoginRole): string {
  switch (code) {
    case "auth/invalid-email":
      return "이메일 형식을 확인해 주세요.";
    case "auth/user-disabled":
      if (role === "teacher") {
        return "선생님 등록 대기(pending) 상태라 로그인할 수 없습니다. 학원에서 활성 처리 후 다시 시도해 주세요.";
      }
      if (role === "parent") {
        return "학부모 등록 대기(pending) 상태라 로그인할 수 없습니다. 학원에서 활성 처리 후 다시 시도해 주세요.";
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

type LoginFormProps = {
  fixedRole?: LoginRole;
};

export function LoginForm({ fixedRole }: LoginFormProps = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [role, setRole] = useState<LoginRole>(() => fixedRole ?? "owner");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [academyId, setAcademyId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [sessionUser, setSessionUser] = useState<User | null>(null);
  const [logoutBusy, setLogoutBusy] = useState(false);

  const configured = isFirebaseConfigured();

  useEffect(() => {
    if (!configured) {
      setSessionUser(null);
      return;
    }
    const auth = getFirebaseAuth();
    const unsub = onAuthStateChanged(auth, (u) => setSessionUser(u));
    return () => unsub();
  }, [configured]);

  useEffect(() => {
    if (fixedRole) {
      setRole(fixedRole);
    }
  }, [fixedRole]);

  useEffect(() => {
    if (!fixedRole) {
      const r = searchParams.get("role");
      if (r === "teacher" || r === "parent" || r === "owner" || r === "academy") {
        setRole(r);
      }
    }
    const msg = searchParams.get("msg");
    if (msg === "existing_account") {
      setBanner("이미 가입된 Google 계정입니다. 로그인해 주세요.");
    } else {
      setBanner(null);
    }
  }, [searchParams, fixedRole]);

  const checkTeacherActivationOrRedirect =
    useCallback(async (): Promise<boolean> => {
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

      /**
       * 초청 발송 직후 — 로그인한 채로 등록 완료(Callable)까지 가야 함.
       * 여기서 session으로 보내면 등록 완료 처리가 불가능해 교착 상태가 됩니다.
       */
      if (state === "invitation_sent") {
        const p = new URLSearchParams();
        if (academyId) p.set("academyId", academyId);
        const qs = p.toString();
        router.replace(`/teacher/complete${qs ? `?${qs}` : ""}`);
        return false;
      }

      const q = new URLSearchParams();
      q.set("state", state);
      if (academyId) q.set("academyId", academyId);
      router.replace(`/teacher/session?${q.toString()}`);
      return false;
    }, [router]);

  const checkParentActivationOrRedirect =
    useCallback(async (): Promise<boolean> => {
      const functions = getFirebaseFunctions();
      const fn = httpsCallable(functions, "getParentActivationState");
      const res = await fn({});
      const data = res.data as {
        anyActive?: boolean;
        primaryStatus?: string | null;
        primaryAcademyId?: string | null;
      };

      if (data?.anyActive) return true;

      const state = data?.primaryStatus ?? "unknown";
      const aid = data?.primaryAcademyId ?? "";

      if (state === "invitation_sent") {
        const p = new URLSearchParams();
        if (aid) p.set("academyId", aid);
        const qs = p.toString();
        router.replace(`/parent/complete${qs ? `?${qs}` : ""}`);
        return false;
      }

      const q = new URLSearchParams();
      q.set("state", state);
      if (aid) q.set("academyId", aid);
      router.replace(`/parent/session?${q.toString()}`);
      return false;
    }, [router]);
  const showEmailAuth =
    role === "owner" || role === "teacher" || role === "parent";
  const showGoogle = role === "owner";
  const showAcademyFields = role === "academy";
  const hasSession = Boolean(sessionUser);
  const sessionBlocked = hasSession;
  const sessionLabel = useMemo(() => {
    if (!sessionUser) return "";
    return (
      sessionUser.email ??
      sessionUser.phoneNumber ??
      sessionUser.displayName?.trim() ??
      "현재 계정"
    );
  }, [sessionUser]);

  const onLogoutForSwitch = useCallback(async () => {
    if (!configured) return;
    setLogoutBusy(true);
    setError(null);
    setResetSent(false);
    try {
      await signOut(getFirebaseAuth());
    } catch (err) {
      const code = err instanceof FirebaseError ? err.code : "";
      setError(
        code ? authErrorMessage(code, role) : "로그아웃에 실패했습니다.",
      );
    } finally {
      setLogoutBusy(false);
    }
  }, [configured, role]);

  const onContinueAsSession = useCallback(async () => {
    setError(null);
    if (!configured) {
      setError("Firebase 환경 변수를 먼저 설정해 주세요.");
      return;
    }
    const auth = getFirebaseAuth();
    const u = auth.currentUser;
    if (!u) return;
    setBusy(true);
    try {
      if (showEmailAuth && !u.emailVerified) {
        router.replace("/verify-email");
        return;
      }
      if (role === "owner") {
        await upsertOwnerProfile(u);
        router.replace("/owner");
        return;
      }
      if (role === "teacher") {
        const ok = await checkTeacherActivationOrRedirect();
        if (ok) router.replace("/teacher");
        return;
      }
      if (role === "parent") {
        const ok = await checkParentActivationOrRedirect();
        if (ok) router.replace("/parent");
        return;
      }
      if (role === "academy") {
        router.replace("/academy");
        return;
      }
    } catch (err) {
      const code = err instanceof FirebaseError ? err.code : "";
      setError(authErrorMessage(code, role));
    } finally {
      setBusy(false);
    }
  }, [
    checkParentActivationOrRedirect,
    checkTeacherActivationOrRedirect,
    configured,
    role,
    router,
    showEmailAuth,
  ]);

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
      if (getFirebaseAuth().currentUser) {
        setError(
          "이미 로그인된 세션이 있습니다. 아래에서 이동하거나 로그아웃한 뒤 다시 시도해 주세요.",
        );
        return;
      }
      setBusy(true);
      try {
        const auth = getFirebaseAuth();
        const cred = await signInWithEmailAndPassword(
          auth,
          email.trim(),
          password,
        );
        if (showEmailAuth && !cred.user.emailVerified) {
          router.replace("/verify-email");
          return;
        }
        if (role === "teacher") {
          const ok = await checkTeacherActivationOrRedirect();
          if (!ok) return;
        }
        if (role === "parent") {
          const ok = await checkParentActivationOrRedirect();
          if (!ok) return;
        }
        if (role === "owner") {
          await upsertOwnerProfile(cred.user);
        }
        router.replace(
          role === "owner"
            ? "/owner"
            : role === "teacher"
              ? "/teacher"
              : role === "parent"
                ? "/parent"
                : "/",
        );
      } catch (err) {
        const code = err instanceof FirebaseError ? err.code : "";
        setError(authErrorMessage(code, role));
      } finally {
        setBusy(false);
      }
    },
    [
      checkParentActivationOrRedirect,
      checkTeacherActivationOrRedirect,
      configured,
      email,
      password,
      router,
      role,
      showEmailAuth,
    ],
  );

  const onGoogleLogin = useCallback(async () => {
    setError(null);
    setResetSent(false);
    if (!configured) {
      setError("Firebase 환경 변수를 먼저 설정해 주세요.");
      return;
    }
    if (getFirebaseAuth().currentUser) {
      setError(
        "이미 로그인된 세션이 있습니다. 아래에서 이동하거나 로그아웃한 뒤 다시 시도해 주세요.",
      );
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
      if (role === "parent") {
        const ok = await checkParentActivationOrRedirect();
        if (!ok) return;
      }
      if (role === "owner") {
        await upsertOwnerProfile(cred.user);
      }
      router.replace(
        role === "owner"
          ? "/owner"
          : role === "teacher"
            ? "/teacher"
            : role === "parent"
              ? "/parent"
              : "/",
      );
    } catch (err) {
      const code = err instanceof FirebaseError ? err.code : "";
      setError(authErrorMessage(code, role));
    } finally {
      setBusy(false);
    }
  }, [
    checkParentActivationOrRedirect,
    checkTeacherActivationOrRedirect,
    configured,
    role,
    router,
  ]);

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
      if (getFirebaseAuth().currentUser) {
        setError("다른 계정으로 학원 로그인하려면 먼저 로그아웃해 주세요.");
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
    <div className="min-h-[100dvh] bg-background px-4 py-10 flex flex-col items-center justify-center pb-[max(2rem,env(safe-area-inset-bottom))]">
      {!configured ? (
        <p className="mb-4 max-w-md rounded-2xl border border-amber-200/80 bg-amber-50/90 px-4 py-3 text-center text-sm text-amber-950 backdrop-blur-sm">
          <code className="font-mono text-xs">.env.example</code>을 참고해{" "}
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
          {fixedRole
            ? `${ROLES.find((x) => x.id === role)?.label ?? ""} 로그인`
            : "로그인"}
        </h1>

        <p className="mt-2 text-center text-xs text-neutral-500">attn.</p>

        {fixedRole ? (
          <p className="mt-3 text-center">
            <Link
              href="/login"
              className="text-xs font-medium text-[#4a90e2] underline-offset-2 hover:underline"
            >
              다른 역할로 로그인
            </Link>
          </p>
        ) : null}

        {!fixedRole ? (
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {ROLES.map((r) => (
              <button
                key={r.id}
                type="button"
                disabled={busy || logoutBusy}
                onClick={() => {
                  setRole(r.id);
                  setError(null);
                  setResetSent(false);
                }}
                className={`rounded-full px-3.5 py-2 text-xs font-medium transition-all ${
                  role === r.id
                    ? "bg-white/75 text-foreground shadow-[0_4px_20px_rgba(0,0,0,0.08)] ring-1 ring-black/10"
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
        ) : null}

        {hasSession ? (
          <div className="mt-5 rounded-2xl border border-amber-200/70 bg-amber-50/80 px-3.5 py-3 text-sm text-amber-950 ring-1 ring-amber-500/15 backdrop-blur-sm">
            <p className="font-medium">이미 로그인된 상태입니다</p>
            <p className="mt-1 text-xs text-amber-900/90">
              <span className="break-all font-mono text-[11px]">
                {sessionLabel}
              </span>
            </p>
            <p className="mt-2 text-xs leading-relaxed text-amber-900/85">
              {role === "academy"
                ? "다른 학원 ID로 로그인하거나 Google·이메일 계정으로 전환하려면 먼저 로그아웃해 주세요."
                : "다른 Google 계정·역할로 로그인하려면 먼저 로그아웃해 주세요. 현재 세션으로 바로 들어가려면 아래를 눌러 주세요."}
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-stretch">
              <button
                type="button"
                disabled={busy || logoutBusy || !configured}
                onClick={onContinueAsSession}
                className="flex-1 rounded-xl bg-[#222] dark:bg-neutral-100 px-3 py-2.5 text-xs font-medium text-white dark:text-neutral-950 shadow-sm transition hover:bg-[#333] dark:hover:bg-white active:scale-[0.99] disabled:opacity-50"
              >
                {busy ? "처리 중…" : "선택한 역할 화면으로 이동"}
              </button>
              <button
                type="button"
                disabled={busy || logoutBusy || !configured}
                onClick={onLogoutForSwitch}
                className="flex-1 rounded-xl border border-amber-800/20 bg-white/60 px-3 py-2.5 text-xs font-medium text-amber-950 transition hover:bg-white/90 active:scale-[0.99] disabled:opacity-50"
              >
                {logoutBusy ? "로그아웃 중…" : "로그아웃 후 전환"}
              </button>
            </div>
          </div>
        ) : null}

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
                className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3.5 text-foreground shadow-inner shadow-white/40 outline-none ring-0 transition placeholder:text-neutral-400 focus:border-[#4a90e2]/50 focus:bg-white/70 focus:shadow-[0_0_0_3px_rgba(74,144,226,0.18)]"
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
                className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3.5 text-foreground shadow-inner shadow-white/40 outline-none focus:border-[#4a90e2]/50 focus:bg-white/70 focus:shadow-[0_0_0_3px_rgba(74,144,226,0.18)]"
                placeholder="포털 비밀번호"
              />
            </div>
            <button
              type="submit"
              disabled={busy || !configured || sessionBlocked}
              className="mt-2 w-full rounded-2xl bg-[#222] dark:bg-neutral-100 py-3.5 text-[15px] font-medium text-white dark:text-neutral-950 shadow-[0_8px_24px_rgba(0,0,0,0.18)] transition hover:bg-[#333] dark:hover:bg-white active:scale-[0.99] disabled:opacity-50"
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
                className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3.5 text-foreground shadow-inner shadow-white/40 outline-none focus:border-[#4a90e2]/50 focus:bg-white/70 focus:shadow-[0_0_0_3px_rgba(74,144,226,0.18)]"
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
                className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3.5 text-foreground shadow-inner shadow-white/40 outline-none focus:border-[#4a90e2]/50 focus:bg-white/70 focus:shadow-[0_0_0_3px_rgba(74,144,226,0.18)]"
              />
            </div>
            <button
              type="submit"
              disabled={busy || !configured || sessionBlocked}
              className="mt-2 w-full rounded-2xl bg-[#222] dark:bg-neutral-100 py-3.5 text-[15px] font-medium text-white dark:text-neutral-950 shadow-[0_8px_24px_rgba(0,0,0,0.18)] transition hover:bg-[#333] dark:hover:bg-white active:scale-[0.99] disabled:opacity-50"
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
              disabled={busy || !configured || sessionBlocked}
              onClick={onGoogleLogin}
              className="flex w-full items-center justify-center gap-3 rounded-2xl border border-neutral-300/70 bg-white/60 dark:border-white/12 dark:bg-white/10 py-3.5 text-[15px] font-medium text-foreground shadow-sm backdrop-blur-md transition hover:bg-white/85 active:scale-[0.99] disabled:opacity-50"
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
                disabled={busy || !configured || sessionBlocked}
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

      {/* <p className="mt-8 text-center text-xs text-neutral-500">
        <Link href="/" className="underline-offset-2 hover:underline">
          홈으로
        </Link>
      </p> */}
    </div>
  );
}
