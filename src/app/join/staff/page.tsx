"use client";

import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { GoogleMark } from "@/components/auth/google-mark";
import { KrPhoneInput } from "@/components/ui/kr-phone-input";
import { PasswordInput } from "@/components/ui/password-input";
import { ProcessStatusModal } from "@/components/ui/process-status-modal";
import { ensureSignupAppCheck } from "@/lib/firebase/app-check";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { getMemberLoginIdFormatError } from "@/lib/member-login-id";
import { getKrPhoneValidationError } from "@/lib/phone/kr-phone";
import { readSignupToken, signupErrorMessage, SIGNUP_LINK_INVALID_MESSAGE } from "@/lib/signup/signup-errors";
import { resolvePasswordConfirmHint } from "@/lib/ui/password-confirm-hint";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3.5 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";
const labelClass = "mb-1.5 block text-xs font-medium text-neutral-600";
const MAX_NAME_LENGTH = 60;

type LoginIdStatus = "idle" | "checking" | "available" | "unavailable";
type Step = "form" | "google_profile";

/**
 * 직원 가입(`/join/staff?token=…`, 2-K) — 학원이 공유한 공용 직원 가입 QR로만 가입한다.
 * 이름·휴대폰 번호(필수) + 로그인 ID·비밀번호, 또는 Google 로그인 뒤 이름·번호.
 * 가입하면 항상 "가입 승인 대기"이고 학원이 승인해야 이용할 수 있다(`registerStaffSignup`).
 * App Check는 로그인 ID 확인·가입 함수를 처음 부르기 직전에만 켠다(`ensureSignupAppCheck`).
 */
function StaffJoinForm() {
  const searchParams = useSearchParams();
  const token = readSignupToken(searchParams.get("token"));

  const [academyName, setAcademyName] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(token ? null : SIGNUP_LINK_INVALID_MESSAGE);
  const [sessionUser, setSessionUser] = useState<User | null>(null);
  const [step, setStep] = useState<Step>("form");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [loginId, setLoginId] = useState("");
  const [loginIdStatus, setLoginIdStatus] = useState<LoginIdStatus>("idle");
  const [loginIdMessage, setLoginIdMessage] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPassword2, setShowPassword2] = useState(false);
  const [confirmBlurred, setConfirmBlurred] = useState(false);
  const [googleEmail, setGoogleEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ loginId: string } | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured()) return;
    return onAuthStateChanged(getFirebaseAuth(), setSessionUser);
  }, []);

  useEffect(() => {
    if (!token || !isFirebaseConfigured()) return;
    let cancelled = false;
    void httpsCallable(getFirebaseFunctions(), "getStaffSignupInfo")({ token })
      .then((res) => {
        if (!cancelled) setAcademyName((res.data as { academyName?: string }).academyName ?? "학원");
      })
      .catch((e) => {
        if (!cancelled) setLoadError(signupErrorMessage(e, "가입 정보를 불러오지 못했습니다."));
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
      void (async () => {
        try {
          await ensureSignupAppCheck();
          await httpsCallable(getFirebaseFunctions(), "checkStaffSignupLoginId")({ token, loginId });
          if (cancelled) return;
          setLoginIdStatus("available");
          setLoginIdMessage("사용할 수 있는 로그인 ID입니다.");
        } catch (e) {
          if (cancelled) return;
          setLoginIdStatus("unavailable");
          setLoginIdMessage(signupErrorMessage(e, "확인에 실패했습니다. 잠시 후 다시 시도해 주세요."));
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loginId, token]);

  /** 이름·번호 — 비밀번호 가입·Google 가입 공통 */
  const profileError = (): string | null => {
    const name = displayName.trim();
    if (!name) return "이름을 입력해 주세요.";
    if (name.length > MAX_NAME_LENGTH) return `이름은 ${MAX_NAME_LENGTH}자 이하로 입력해 주세요.`;
    return getKrPhoneValidationError(phone);
  };

  const onPasswordJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const pe = profileError();
    if (pe) {
      setError(pe);
      return;
    }
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
      await ensureSignupAppCheck();
      const res = await httpsCallable(getFirebaseFunctions(), "registerStaffSignup")({
        token,
        method: "password",
        displayName: displayName.trim(),
        phone,
        loginId,
        password,
      });
      setDone({ loginId: (res.data as { loginId?: string }).loginId ?? loginId });
    } catch (err) {
      setError(signupErrorMessage(err, "가입에 실패했습니다."));
    } finally {
      setBusy(null);
    }
  };

  /** Google 1단계 — 로그인만 하고 이름·번호를 받는다(가입 함수는 2단계에서) */
  const onGoogleStart = useCallback(async () => {
    setError(null);
    setBusy("Google 계정 확인 중");
    const auth = getFirebaseAuth();
    try {
      const cred = await signInWithPopup(auth, new GoogleAuthProvider());
      setGoogleEmail(cred.user.email ?? "");
      setDisplayName((prev) => prev.trim() || cred.user.displayName || "");
      setStep("google_profile");
    } catch (err) {
      await signOut(auth).catch(() => undefined);
      setError(signupErrorMessage(err, "Google 로그인을 하지 못했습니다."));
    } finally {
      setBusy(null);
    }
  }, []);

  const onGoogleBack = async () => {
    setError(null);
    setStep("form");
    setGoogleEmail("");
    await signOut(getFirebaseAuth()).catch(() => undefined);
  };

  const onGoogleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const pe = profileError();
    if (pe) {
      setError(pe);
      return;
    }
    setBusy("가입 신청 중");
    const auth = getFirebaseAuth();
    try {
      await ensureSignupAppCheck();
      await httpsCallable(getFirebaseFunctions(), "registerStaffSignup")({
        token,
        method: "google",
        displayName: displayName.trim(),
        phone,
      });
      setDone({ loginId: "" });
      // 승인 전에는 이용할 수 없으므로 Google 세션을 남기지 않음
      await signOut(auth).catch(() => undefined);
    } catch (err) {
      setError(signupErrorMessage(err, "Google로 가입하지 못했습니다."));
    } finally {
      setBusy(null);
    }
  };

  const passwordConfirmHint = resolvePasswordConfirmHint(password, password2, confirmBlurred);
  // Google 2단계는 방금 로그인한 Google 세션을 쓰므로 막지 않음
  const blockedBySession = Boolean(sessionUser) && !done && step === "form";

  if (done) {
    return (
      <div className="text-center">
        <p className="text-2xl font-semibold tracking-tight text-emerald-700">가입 신청 완료</p>
        <p className="mt-4 text-sm leading-relaxed text-neutral-600">
          {academyName ?? "학원"}에서 승인하면 바로 이용할 수 있어요.
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
    return (
      <div className="space-y-4 text-center" data-signup-invalid>
        <p className="break-keep text-sm text-red-700">{loadError}</p>
        <Link href="/login/teacher" className="text-sm text-[#4a90e2] underline">
          직원 로그인
        </Link>
      </div>
    );
  }

  if (academyName === null) {
    return <p className="text-center text-sm text-neutral-500">가입 정보를 확인하는 중…</p>;
  }

  const profileFields = (
    <>
      <div>
        <label htmlFor="join-name" className={labelClass}>
          이름 <span className="text-red-600">*</span>
        </label>
        <input
          id="join-name"
          autoComplete="name"
          value={displayName}
          maxLength={MAX_NAME_LENGTH}
          onChange={(e) => setDisplayName(e.target.value)}
          className={inputClass}
          disabled={blockedBySession || busy !== null}
        />
      </div>
      <div>
        <label htmlFor="join-phone" className={labelClass}>
          휴대폰 번호 <span className="text-red-600">*</span>
        </label>
        <KrPhoneInput
          id="join-phone"
          value={phone}
          onChange={setPhone}
          className={inputClass}
          disabled={blockedBySession || busy !== null}
        />
        <p className="mt-1 break-keep text-[11px] text-neutral-500">학원이 등록해 둔 번호와 같으면 승인할 때 확인해요.</p>
      </div>
    </>
  );

  return (
    <div>
      <p className="text-center text-sm leading-relaxed text-neutral-700">
        <span className="font-semibold text-foreground">{academyName}</span>에 직원으로 가입해요.
      </p>
      <p className="mt-1 text-center text-xs text-neutral-500">가입한 뒤 학원이 승인하면 이용할 수 있어요.</p>

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
        <p className="mt-5 break-keep rounded-2xl bg-red-500/10 px-3 py-2.5 text-center text-sm text-red-800" role="alert">
          {error}
        </p>
      ) : null}

      {step === "google_profile" ? (
        <form className="mt-6 space-y-4" onSubmit={(e) => void onGoogleJoin(e)} noValidate>
          <p className="text-center text-xs text-neutral-500">
            Google 계정 <span className="font-mono text-foreground">{googleEmail || "(이메일 없음)"}</span>으로 가입합니다.
          </p>
          {profileFields}
          <button
            type="submit"
            disabled={busy !== null}
            className="w-full rounded-2xl bg-[#222] py-3.5 text-[15px] font-medium text-white disabled:opacity-50"
          >
            가입 신청
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void onGoogleBack()}
            className="w-full rounded-2xl border border-neutral-300/70 py-3 text-sm font-medium text-neutral-700"
          >
            다른 방식으로 가입
          </button>
        </form>
      ) : (
        <>
          <form className="mt-6 space-y-4" onSubmit={(e) => void onPasswordJoin(e)} noValidate>
            {profileFields}
            <div>
              <label htmlFor="join-login-id" className={labelClass}>
                로그인 ID <span className="text-red-600">*</span>
              </label>
              <input
                id="join-login-id"
                autoComplete="username"
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                className={inputClass}
                placeholder="한글 4~12자 또는 영문·숫자 4~20자"
                disabled={blockedBySession || busy !== null}
              />
              {loginIdMessage ? (
                <p
                  className={`mt-1 break-keep text-[11px] ${
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
              labelClassName={labelClass}
              disabled={blockedBySession || busy !== null}
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
              labelClassName={labelClass}
              disabled={blockedBySession || busy !== null}
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
            onClick={() => void onGoogleStart()}
            className="flex w-full items-center justify-center gap-3 rounded-2xl border border-neutral-300/70 bg-white/60 py-3.5 text-[15px] font-medium text-foreground disabled:opacity-50"
          >
            <GoogleMark />
            Google 계정으로 가입
          </button>
          <p className="mt-3 text-center text-[11px] text-neutral-500">Google 로그인 뒤 이름·번호를 입력합니다.</p>
        </>
      )}

      <ProcessStatusModal open={busy !== null} title={busy ?? ""} description="잠시만 기다려 주세요." animated />
    </div>
  );
}

export default function StaffJoinPage() {
  return (
    <div className="min-h-[100dvh] bg-background px-4 py-10 flex flex-col items-center justify-center pb-[max(2rem,env(safe-area-inset-bottom))]">
      <div className="glass-card-hero w-full max-w-[400px] p-8">
        <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">직원 가입</h1>
        <p className="mt-2 mb-6 text-center text-xs text-neutral-500">attn.</p>
        <Suspense fallback={<p className="text-center text-sm text-neutral-500">불러오는 중…</p>}>
          <StaffJoinForm />
        </Suspense>
      </div>
    </div>
  );
}
