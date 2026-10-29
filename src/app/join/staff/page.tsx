"use client";

import { FirebaseError } from "firebase/app";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { GoogleMark } from "@/components/auth/google-mark";
import { PasswordInput } from "@/components/ui/password-input";
import { ProcessStatusModal } from "@/components/ui/process-status-modal";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { getMemberLoginIdFormatError } from "@/lib/member-login-id";
import { resolvePasswordConfirmHint } from "@/lib/ui/password-confirm-hint";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3.5 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

type InviteInfo = {
  academyName: string;
  displayName: string;
  roleName: string;
  expiresAtMillis: number;
};

type LoginIdStatus = "idle" | "checking" | "available" | "unavailable";

function errMsg(err: unknown, fallback: string): string {
  return err instanceof FirebaseError && err.message ? err.message : fallback;
}

/**
 * 직원 초대 링크(`/join/staff?token=…`) — 학원이 만든 1회용 링크로 로그인 ID·비밀번호 또는 Google로 가입.
 * 가입 직후는 "승인 대기"이며 학원이 승인해야 이용할 수 있다(`acceptStaffInvite`).
 */
function StaffJoinForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token")?.trim() ?? "";

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionUser, setSessionUser] = useState<User | null>(null);
  const [loginId, setLoginId] = useState("");
  const [loginIdStatus, setLoginIdStatus] = useState<LoginIdStatus>("idle");
  const [loginIdMessage, setLoginIdMessage] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPassword2, setShowPassword2] = useState(false);
  const [confirmBlurred, setConfirmBlurred] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ loginId: string } | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured()) return;
    return onAuthStateChanged(getFirebaseAuth(), setSessionUser);
  }, []);

  useEffect(() => {
    if (!token) {
      setLoadError("초대 링크가 올바르지 않습니다. 학원에서 받은 링크를 다시 열어 주세요.");
      return;
    }
    if (!isFirebaseConfigured()) return;
    let cancelled = false;
    void httpsCallable(getFirebaseFunctions(), "getStaffInviteInfo")({ token })
      .then((res) => {
        if (!cancelled) setInfo(res.data as InviteInfo);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(errMsg(e, "초대 정보를 불러오지 못했습니다."));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!loginId.trim()) {
      setLoginIdStatus("idle");
      setLoginIdMessage(null);
      return;
    }
    const formatError = getMemberLoginIdFormatError(loginId);
    if (formatError) {
      setLoginIdStatus("unavailable");
      setLoginIdMessage(formatError);
      return;
    }
    let cancelled = false;
    setLoginIdStatus("checking");
    setLoginIdMessage("사용 가능 여부를 확인하고 있어요.");
    const timer = window.setTimeout(() => {
      void httpsCallable(getFirebaseFunctions(), "checkStaffInviteLoginId")({ token, loginId })
        .then(() => {
          if (cancelled) return;
          setLoginIdStatus("available");
          setLoginIdMessage("사용할 수 있는 로그인 ID입니다.");
        })
        .catch((e) => {
          if (cancelled) return;
          setLoginIdStatus("unavailable");
          setLoginIdMessage(errMsg(e, "확인에 실패했습니다. 잠시 후 다시 시도해 주세요."));
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loginId, token]);

  const onPasswordJoin = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (loginIdStatus !== "available") {
        setError(loginIdMessage ?? "로그인 ID를 확인해 주세요.");
        return;
      }
      if (password.length < 6) {
        setError("비밀번호는 6자 이상이어야 합니다.");
        return;
      }
      if (password !== password2) {
        setError("비밀번호가 서로 일치하지 않습니다.");
        return;
      }
      setBusy("가입 신청 중");
      try {
        const res = await httpsCallable(getFirebaseFunctions(), "acceptStaffInvite")({
          token,
          method: "password",
          loginId,
          password,
        });
        setDone({ loginId: (res.data as { loginId?: string }).loginId ?? loginId });
      } catch (err) {
        setError(errMsg(err, "가입에 실패했습니다."));
      } finally {
        setBusy(null);
      }
    },
    [loginId, loginIdMessage, loginIdStatus, password, password2, token],
  );

  const onGoogleJoin = useCallback(async () => {
    setError(null);
    setBusy("Google 계정 확인 중");
    const auth = getFirebaseAuth();
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      await httpsCallable(getFirebaseFunctions(), "acceptStaffInvite")({ token, method: "google" });
      setDone({ loginId: "" });
    } catch (err) {
      setError(errMsg(err, "Google로 가입하지 못했습니다."));
    } finally {
      // 승인 전에는 이용할 수 없으므로 Google 세션을 남기지 않음
      await signOut(auth).catch(() => undefined);
      setBusy(null);
    }
  }, [token]);

  const passwordConfirmHint = resolvePasswordConfirmHint(password, password2, confirmBlurred);
  const blockedBySession = Boolean(sessionUser) && !done;

  if (done) {
    return (
      <div className="text-center">
        <p className="text-2xl font-semibold tracking-tight text-emerald-700">가입 신청 완료</p>
        <p className="mt-4 text-sm leading-relaxed text-neutral-600">
          {info?.academyName ?? "학원"}에서 승인하면 바로 이용할 수 있어요.
        </p>
        {done.loginId ? (
          <p className="mt-3 text-sm text-neutral-700">
            로그인 ID <span className="font-mono font-medium text-foreground">{done.loginId}</span>
          </p>
        ) : (
          <p className="mt-3 text-sm text-neutral-700">로그인할 때 「Google 계정으로 로그인」을 눌러 주세요.</p>
        )}
        <Link
          href="/login/teacher"
          className="mt-6 inline-flex w-full justify-center rounded-2xl bg-[#222] py-3.5 text-sm font-medium text-white"
        >
          로그인 화면으로
        </Link>
      </div>
    );
  }

  if (loadError) {
    return <p className="text-center text-sm text-red-700">{loadError}</p>;
  }

  if (!info) {
    return <p className="text-center text-sm text-neutral-500">초대 정보를 확인하는 중…</p>;
  }

  return (
    <div>
      <p className="text-center text-sm leading-relaxed text-neutral-700">
        <span className="font-semibold text-foreground">{info.academyName}</span>에서{" "}
        <span className="font-semibold text-foreground">{info.displayName}</span> 님을 직원으로 초대했어요.
      </p>
      <p className="mt-1 text-center text-xs text-neutral-500">권한: {info.roleName}</p>

      {blockedBySession ? (
        <div className="mt-5 rounded-2xl border border-amber-200/70 bg-amber-50/80 px-3.5 py-3 text-xs text-amber-950">
          <p>다른 계정으로 로그인되어 있습니다. 로그아웃한 뒤 가입해 주세요.</p>
          <button
            type="button"
            onClick={() => void signOut(getFirebaseAuth())}
            className="mt-2 rounded-[8px] border border-amber-800/20 bg-white/70 px-3 py-2 font-medium"
          >
            로그아웃
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="mt-5 rounded-2xl bg-red-500/10 px-3 py-2.5 text-center text-sm text-red-800" role="alert">
          {error}
        </p>
      ) : null}

      <form className="mt-6 space-y-4" onSubmit={onPasswordJoin}>
        <div>
          <label htmlFor="join-login-id" className="mb-1.5 block text-xs font-medium text-neutral-600">
            로그인 ID
          </label>
          <input
            id="join-login-id"
            autoComplete="username"
            value={loginId}
            onChange={(e) => setLoginId(e.target.value)}
            className={inputClass}
            placeholder="한글 4~12자 또는 영문·숫자 4~20자"
            disabled={blockedBySession}
          />
          {loginIdMessage ? (
            <p
              className={`mt-1 text-[11px] ${
                loginIdStatus === "available"
                  ? "text-emerald-700"
                  : loginIdStatus === "checking"
                    ? "text-neutral-500"
                    : "text-red-600"
              }`}
            >
              {loginIdMessage}
            </p>
          ) : null}
        </div>
        <PasswordInput
          id="join-password"
          label="비밀번호 (6자 이상)"
          value={password}
          onChangeAction={setPassword}
          visible={showPassword}
          onToggleVisibleAction={() => setShowPassword((v) => !v)}
          inputClassName={inputClass}
          labelClassName="mb-1.5 block text-xs font-medium text-neutral-600"
          disabled={blockedBySession}
          autoComplete="new-password"
        />
        <PasswordInput
          id="join-password2"
          label="비밀번호 확인"
          value={password2}
          onChangeAction={setPassword2}
          onBlurAction={() => setConfirmBlurred(true)}
          visible={showPassword2}
          onToggleVisibleAction={() => setShowPassword2((v) => !v)}
          confirmHint={passwordConfirmHint}
          inputClassName={inputClass}
          labelClassName="mb-1.5 block text-xs font-medium text-neutral-600"
          disabled={blockedBySession}
          autoComplete="new-password"
        />
        <button
          type="submit"
          disabled={blockedBySession || busy !== null}
          className="w-full rounded-2xl bg-[#222] py-3.5 text-[15px] font-medium text-white disabled:opacity-50"
        >
          가입 신청
        </button>
      </form>

      <div className="my-6 flex items-center gap-3">
        <span className="h-px flex-1 bg-neutral-300" />
        <span className="shrink-0 text-[11px] text-neutral-500">또는</span>
        <span className="h-px flex-1 bg-neutral-300" />
      </div>
      <button
        type="button"
        disabled={blockedBySession || busy !== null}
        onClick={() => void onGoogleJoin()}
        className="flex w-full items-center justify-center gap-3 rounded-2xl border border-neutral-300/70 bg-white/60 py-3.5 text-[15px] font-medium text-foreground disabled:opacity-50"
      >
        <GoogleMark />
        Google 계정으로 가입
      </button>
      <p className="mt-4 text-center text-[11px] text-neutral-500">
        이 링크는 {new Date(info.expiresAtMillis).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}까지 한 번만
        사용할 수 있어요.
      </p>

      <ProcessStatusModal open={busy !== null} title={busy ?? ""} description="잠시만 기다려 주세요." animated />
    </div>
  );
}

export default function StaffJoinPage() {
  return (
    <div className="min-h-[100dvh] bg-background px-4 py-10 flex flex-col items-center justify-center pb-[max(2rem,env(safe-area-inset-bottom))]">
      <div className="glass-card-hero w-full max-w-[400px] p-8">
        <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">직원 초대</h1>
        <p className="mt-2 mb-6 text-center text-xs text-neutral-500">attn.</p>
        <Suspense fallback={<p className="text-center text-sm text-neutral-500">불러오는 중…</p>}>
          <StaffJoinForm />
        </Suspense>
      </div>
    </div>
  );
}
