"use client";

import { FirebaseError } from "firebase/app";
import { GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { PasswordInput } from "@/components/ui/password-input";
import { GoogleMark } from "@/components/auth/google-mark";
import { SignupCompleteModal } from "@/components/auth/signup-complete-modal";
import { ProcessStatusModal } from "@/components/ui/process-status-modal";
import { resolvePasswordConfirmHint } from "@/lib/ui/password-confirm-hint";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import {
  formatKrPhoneInput,
  getKrPhoneValidationError,
  KR_PHONE_INPUT_MAX_LENGTH,
} from "@/lib/phone/kr-phone";
import {
  getParentLoginIdFormatError,
  normalizeParentLoginId,
} from "@/lib/parent-login-id";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3.5 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

function InlineSpinner({ className }: { className?: string }) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full border-2 border-neutral-200 border-t-[#222] animate-spin dark:border-white/20 dark:border-t-white ${className ?? "h-4 w-4"}`}
      aria-hidden
    />
  );
}

function ClipboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="8" y="8" width="12" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

type SignupStep = "form" | "google_profile";

function ParentJoinForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const academyId = searchParams.get("academyId")?.trim() ?? "";

  const [academyName, setAcademyName] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [loginId, setLoginId] = useState("");
  const [loginIdStatus, setLoginIdStatus] = useState<
    "idle" | "checking" | "available" | "taken" | "invalid"
  >("idle");
  const [loginIdMessage, setLoginIdMessage] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPassword2, setShowPassword2] = useState(false);
  const [confirmBlurred, setConfirmBlurred] = useState(false);
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signupStep, setSignupStep] = useState<SignupStep>("form");
  const [googleLoginId, setGoogleLoginId] = useState("");
  const [doneLoginId, setDoneLoginId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [loadingModal, setLoadingModal] = useState<{
    title: string;
    description?: string;
  } | null>(null);
  const [signupCompleteOpen, setSignupCompleteOpen] = useState(false);

  useEffect(() => {
    if (!academyId || !isFirebaseConfigured()) {
      setLoadErr(academyId ? null : "학원 정보가 없습니다. 학원에서 받은 링크를 다시 열어 주세요.");
      return;
    }
    let cancelled = false;
    setLoadingModal({
      title: "학원 정보 확인 중",
      description: "가입할 학원 이름을 확인하고 있어요.",
    });
    (async () => {
      try {
        const fn = httpsCallable(getFirebaseFunctions(), "getParentSignupAcademyInfo");
        const res = await fn({ academyId });
        const data = res.data as { name?: string };
        if (!cancelled) {
          setAcademyName(data.name ?? "학원");
          setLoadErr(null);
          setLoadingModal(null);
        }
      } catch (e) {
        if (!cancelled) {
          setLoadErr(
            e instanceof FirebaseError ? e.message : "학원 정보를 불러오지 못했습니다.",
          );
          setLoadingModal(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyId]);

  useEffect(() => {
    const formatErr = getParentLoginIdFormatError(loginId);
    if (!loginId.trim()) {
      setLoginIdStatus("idle");
      setLoginIdMessage(null);
      return;
    }
    if (formatErr) {
      setLoginIdStatus("invalid");
      setLoginIdMessage(formatErr);
      return;
    }
    let cancelled = false;
    setLoginIdStatus("checking");
    setLoginIdMessage("사용 가능 여부를 확인하고 있어요.");
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const fn = httpsCallable(getFirebaseFunctions(), "checkParentLoginIdAvailable");
          await fn({ loginId });
          if (!cancelled) {
            setLoginIdStatus("available");
            setLoginIdMessage("사용할 수 있는 로그인 ID입니다.");
          }
        } catch (e) {
          if (!cancelled) {
            const msg =
              e instanceof FirebaseError
                ? e.message
                : "확인에 실패했습니다. 잠시 후 다시 시도해 주세요.";
            if (e instanceof FirebaseError && e.code === "functions/already-exists") {
              setLoginIdStatus("taken");
            } else if (e instanceof FirebaseError && e.code === "functions/invalid-argument") {
              setLoginIdStatus("invalid");
            } else {
              setLoginIdStatus("invalid");
            }
            setLoginIdMessage(msg);
          }
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loginId]);

  const passwordConfirmHint = resolvePasswordConfirmHint(password, password2, confirmBlurred);

  const onGoogleSignup = useCallback(async () => {
    setError(null);
    if (!academyId) {
      return;
    }
    setGoogleBusy(true);
    setLoadingModal({
      title: "Google 계정 연결 중",
      description: "Google 로그인을 확인하고 있어요.",
    });
    try {
      const auth = getFirebaseAuth();
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      const statusFn = httpsCallable(getFirebaseFunctions(), "getParentSignupGoogleStatus");
      const statusRes = await statusFn({ academyId });
      const status = statusRes.data as {
        loginId?: string;
        suggestedDisplayName?: string;
        alreadyMember?: boolean;
        loginIdTaken?: boolean;
      };
      if (status.alreadyMember) {
        setLoadingModal(null);
        router.replace("/parent");
        return;
      }
      if (status.loginIdTaken) {
        await signOut(auth);
        setError("이 Google 계정은 이미 가입되어 있습니다. 로그인해 주세요.");
        return;
      }
      setGoogleLoginId(status.loginId ?? "");
      setDisplayName(status.suggestedDisplayName ?? "");
      setSignupStep("google_profile");
    } catch (err) {
      const auth = getFirebaseAuth();
      if (auth.currentUser) {
        await signOut(auth).catch(() => undefined);
      }
      setError(err instanceof FirebaseError ? err.message : "Google 가입을 시작하지 못했습니다.");
    } finally {
      setGoogleBusy(false);
      setLoadingModal(null);
    }
  }, [academyId, router]);

  const onGoogleProfileBack = useCallback(async () => {
    setError(null);
    setSignupStep("form");
    setGoogleLoginId("");
    try {
      await signOut(getFirebaseAuth());
    } catch {
      /* ignore */
    }
  }, []);

  const onGoogleComplete = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!displayName.trim()) {
        setError("이름을 입력해 주세요.");
        return;
      }
      if (displayName.trim().length > 60) {
        setError("이름은 60자 이하로 입력해 주세요.");
        return;
      }
      const phoneErr = getKrPhoneValidationError(phone);
      if (phoneErr) {
        setError(phoneErr);
        return;
      }
      if (!agree) {
        setError("서비스 이용에 동의해 주세요.");
        return;
      }
      try {
        setLoadingModal({
          title: "학부모 계정 등록 중",
          description: "이름·연락처를 저장하고 가입을 마무리하고 있어요.",
        });
        const fn = httpsCallable(getFirebaseFunctions(), "registerParentGoogleSignup");
        const res = await fn({
          academyId,
          displayName: displayName.trim(),
          phone: formatKrPhoneInput(phone),
          agreeTerms: true,
        });
        const data = res.data as { loginId?: string };
        setLoadingModal(null);
        setDoneLoginId(data.loginId ?? googleLoginId);
      } catch (err) {
        setLoadingModal(null);
        setError(err instanceof FirebaseError ? err.message : "가입에 실패했습니다.");
      }
    },
    [academyId, agree, displayName, googleLoginId, phone],
  );

  const onCopyLoginId = useCallback(async () => {
    if (!doneLoginId) {
      return;
    }
    try {
      await navigator.clipboard.writeText(doneLoginId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [doneLoginId]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!displayName.trim()) {
        setError("이름을 입력해 주세요.");
        return;
      }
      if (displayName.trim().length > 60) {
        setError("이름은 60자 이하로 입력해 주세요.");
        return;
      }
      const phoneErr = getKrPhoneValidationError(phone);
      if (phoneErr) {
        setError(phoneErr);
        return;
      }
      const em = contactEmail.trim().toLowerCase();
      if (!em || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
        setError("이메일 형식을 확인해 주세요.");
        return;
      }
      if (!loginId.trim()) {
        setError("로그인 ID를 입력해 주세요.");
        return;
      }
      const formatErr = getParentLoginIdFormatError(loginId);
      if (formatErr) {
        setError(formatErr);
        return;
      }
      if (loginIdStatus !== "available") {
        setError("사용 가능한 로그인 ID를 입력해 주세요.");
        return;
      }
      if (!password) {
        setError("비밀번호를 입력해 주세요.");
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
      if (!agree) {
        setError("서비스 이용에 동의해 주세요.");
        return;
      }
      try {
        setLoadingModal({
          title: "1단계 · 학부모 계정 생성 중",
          description: "로그인 ID와 계정 정보를 안전하게 등록하고 있어요.",
        });
        const fn = httpsCallable(getFirebaseFunctions(), "registerParentSelfSignup");
        const res = await fn({
          academyId,
          loginId: normalizeParentLoginId(loginId),
          displayName: displayName.trim(),
          contactEmail: em,
          phone: formatKrPhoneInput(phone),
          password,
          agreeTerms: true,
        });
        const data = res.data as { loginId?: string };
        setLoadingModal(null);
        setDoneLoginId(data.loginId ?? normalizeParentLoginId(loginId));
        setSignupCompleteOpen(true);
      } catch (err) {
        setLoadingModal(null);
        setError(err instanceof FirebaseError ? err.message : "가입에 실패했습니다.");
      }
    },
    [academyId, agree, contactEmail, displayName, loginId, loginIdStatus, password, password2, phone],
  );

  if (!isFirebaseConfigured()) {
    return <p className="text-sm text-neutral-600">Firebase 설정이 필요합니다.</p>;
  }

  return (
    <>
      <ProcessStatusModal
        open={loadingModal !== null}
        title={loadingModal?.title ?? ""}
        description={loadingModal?.description}
      />
      <SignupCompleteModal
        open={signupCompleteOpen}
        title="회원가입 완료!"
        description="회원님의 이메일 주소로 인증 코드를 발송했어요! 다음 로그인 시 인증 코드를 입력해 주세요."
        onConfirmAction={() => {
          setSignupCompleteOpen(false);
          const id = doneLoginId ?? normalizeParentLoginId(loginId);
          const q = id ? `?loginId=${encodeURIComponent(id)}` : "";
          router.replace(`/login/parent${q}`);
        }}
      />

      {loadErr ? (
        <div className="space-y-4 text-center">
          <p className="text-sm text-red-700">{loadErr}</p>
          <Link href="/login/parent" className="text-sm text-[#4a90e2] underline">
            학부모 로그인
          </Link>
        </div>
      ) : null}

      {!loadErr && !academyId ? (
        <p className="text-center text-sm text-neutral-600">
          유효하지 않은 링크입니다. 학원에 문의해 주세요.
        </p>
      ) : null}

      {!loadErr && academyId && academyName !== null && doneLoginId ? (
        <div className="space-y-4 text-center">
          <p className="text-lg font-semibold text-emerald-800">가입이 완료되었습니다</p>
          <p className="text-sm text-neutral-600">
            다음부터 로그인할 때 사용할 <strong>로그인 ID</strong>입니다. 꼭 메모해 두세요.
          </p>
          <div className="flex items-center gap-2 rounded-xl bg-white/60 px-3 py-3 ring-1 ring-black/5">
            <p className="min-w-0 flex-1 break-all text-left font-mono text-sm">{doneLoginId}</p>
            <button
              type="button"
              onClick={() => void onCopyLoginId()}
              className="shrink-0 rounded-lg p-2 text-neutral-500 transition hover:bg-black/5 hover:text-foreground"
              aria-label="로그인 ID 복사"
            >
              <ClipboardIcon />
            </button>
          </div>
          {copied ? (
            <p className="text-xs text-emerald-600">클립보드에 복사했습니다.</p>
          ) : null}
          <button
            type="button"
            onClick={() => router.replace("/parent")}
            className="w-full rounded-2xl bg-[#222] py-3.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950"
          >
            학부모 홈으로
          </button>
        </div>
      ) : null}

      {!loadErr && academyId && academyName !== null && !doneLoginId && signupStep === "google_profile" ? (
        <form className="space-y-4" onSubmit={(e) => void onGoogleComplete(e)} noValidate>
          <p className="text-center text-sm text-neutral-600">
            <span className="font-medium text-foreground">{academyName}</span> · Google 가입
          </p>
          <p className="text-center text-xs text-neutral-500">
            로그인 ID는 Google 이메일 주소로 자동 설정됩니다.
          </p>
          {error ? (
            <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-800" role="alert">
              {error}
            </p>
          ) : null}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-neutral-600" htmlFor="pj-google-login">
              로그인 ID (Google 이메일)
            </label>
            <input
              id="pj-google-login"
              className={`${inputClass} bg-neutral-100/80 dark:bg-white/5`}
              value={googleLoginId}
              readOnly
              disabled
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-neutral-600" htmlFor="pj-g-name">
              이름 <span className="text-red-600">*</span>
            </label>
            <input
              id="pj-g-name"
              className={inputClass}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={60}
              autoComplete="name"
              required
              disabled={loadingModal !== null}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-neutral-600" htmlFor="pj-g-phone">
              휴대폰 번호 <span className="text-red-600">*</span>
            </label>
            <input
              id="pj-g-phone"
              type="tel"
              className={inputClass}
              value={phone}
              onChange={(e) => setPhone(formatKrPhoneInput(e.target.value))}
              maxLength={KR_PHONE_INPUT_MAX_LENGTH}
              autoComplete="tel"
              inputMode="numeric"
              required
              disabled={loadingModal !== null}
              placeholder="010-1234-5678"
            />
          </div>
          <label className="flex items-start gap-2 text-xs text-neutral-600">
            <input
              type="checkbox"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
              className="mt-0.5"
              disabled={loadingModal !== null}
            />
            <span>attn. 학부모 서비스 이용 및 개인정보 처리에 동의합니다. (필수)</span>
          </label>
          <button
            type="submit"
            disabled={loadingModal !== null}
            className="w-full rounded-2xl bg-[#222] py-3.5 text-[15px] font-medium text-white disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-950"
          >
            가입 완료
          </button>
          <button
            type="button"
            disabled={loadingModal !== null}
            onClick={() => void onGoogleProfileBack()}
            className="w-full rounded-2xl border border-neutral-300/70 py-3 text-sm font-medium text-neutral-700"
          >
            다른 방식으로 가입
          </button>
        </form>
      ) : null}

      {!loadErr && academyId && academyName !== null && !doneLoginId && signupStep === "form" ? (
        <form className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
          <p className="text-center text-sm text-neutral-600">
            <span className="font-medium text-foreground">{academyName}</span> 학부모 회원 가입
          </p>
          {error ? (
            <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-800" role="alert">
              {error}
            </p>
          ) : null}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-neutral-600" htmlFor="pj-name">
              이름 <span className="text-red-600">*</span>
            </label>
            <input
              id="pj-name"
              className={inputClass}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={60}
              autoComplete="name"
              required
              disabled={loadingModal !== null}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-neutral-600" htmlFor="pj-email">
              이메일 <span className="text-red-600">*</span>
            </label>
            <input
              id="pj-email"
              type="email"
              className={inputClass}
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              autoComplete="email"
              required
              disabled={loadingModal !== null}
              placeholder="name@example.com"
            />
            <p className="mt-1 text-[11px] text-neutral-500">
              가입 확인용 인증 코드가 발송됩니다.
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-neutral-600" htmlFor="pj-phone">
              휴대폰 번호 <span className="text-red-600">*</span>
            </label>
            <input
              id="pj-phone"
              type="tel"
              className={inputClass}
              value={phone}
              onChange={(e) => setPhone(formatKrPhoneInput(e.target.value))}
              maxLength={KR_PHONE_INPUT_MAX_LENGTH}
              autoComplete="tel"
              inputMode="numeric"
              required
              disabled={loadingModal !== null}
              placeholder="010-1234-5678"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-neutral-600" htmlFor="pj-login-id">
              로그인 ID <span className="text-red-600">*</span>
            </label>
            <div className="relative">
              <input
                id="pj-login-id"
                className={`${inputClass} ${loginIdStatus === "checking" ? "pr-11" : ""}`}
                value={loginId}
                onChange={(e) => setLoginId(e.target.value.toLowerCase())}
                maxLength={20}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                disabled={loadingModal !== null}
                placeholder="예: kim_mom"
                aria-busy={loginIdStatus === "checking"}
              />
              {loginIdStatus === "checking" ? (
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                  <InlineSpinner className="h-5 w-5" />
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-[11px] text-neutral-500">
              영문 소문자·숫자·밑줄(_), 4~20자. 전 서비스에서 유일해야 합니다.
            </p>
            {loginIdMessage ? (
              <p
                className={`mt-1 flex items-center gap-2 text-xs ${
                  loginIdStatus === "available"
                    ? "text-emerald-600"
                    : loginIdStatus === "checking"
                      ? "text-neutral-500"
                      : "text-red-600"
                }`}
              >
                {loginIdStatus === "checking" ? <InlineSpinner className="h-3.5 w-3.5" /> : null}
                <span>{loginIdMessage}</span>
              </p>
            ) : null}
          </div>
          <PasswordInput
            id="pj-pw"
            label={
              <>
                비밀번호 <span className="text-red-600">*</span>
              </>
            }
            value={password}
            onChangeAction={setPassword}
            visible={showPassword}
            onToggleVisibleAction={() => setShowPassword((v) => !v)}
            inputClassName={inputClass}
            disabled={loadingModal !== null}
            required
            minLength={6}
          />
          <PasswordInput
            id="pj-pw2"
            label={
              <>
                비밀번호 확인 <span className="text-red-600">*</span>
              </>
            }
            value={password2}
            onChangeAction={setPassword2}
            onBlurAction={() => setConfirmBlurred(true)}
            visible={showPassword2}
            onToggleVisibleAction={() => setShowPassword2((v) => !v)}
            confirmHint={passwordConfirmHint}
            inputClassName={inputClass}
            disabled={loadingModal !== null}
            required
            minLength={6}
          />
          <label className="flex items-start gap-2 text-xs text-neutral-600">
            <input
              type="checkbox"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
              className="mt-0.5"
              disabled={loadingModal !== null}
            />
            <span>attn. 학부모 서비스 이용 및 개인정보 처리에 동의합니다. (필수)</span>
          </label>
          <button
            type="submit"
            disabled={loadingModal !== null || googleBusy}
            className="w-full rounded-2xl bg-[#222] py-3.5 text-[15px] font-medium text-white disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-950"
          >
            가입하기
          </button>

          <div className="flex items-center gap-3 py-1">
            <span className="h-px flex-1 bg-neutral-200 dark:bg-white/10" />
            <span className="shrink-0 text-[11px] text-neutral-500">또는</span>
            <span className="h-px flex-1 bg-neutral-200 dark:bg-white/10" />
          </div>

          <button
            type="button"
            disabled={loadingModal !== null || googleBusy}
            onClick={() => void onGoogleSignup()}
            className="flex w-full items-center justify-center gap-3 rounded-2xl border border-neutral-300/70 bg-white/60 py-3.5 text-[15px] font-medium text-foreground shadow-sm transition hover:bg-white/85 active:scale-[0.99] disabled:opacity-50 dark:border-white/12 dark:bg-white/10"
          >
            <GoogleMark />
            Google로 학부모 가입
          </button>

          <p className="text-center text-xs text-neutral-500">
            Google 가입 시 로그인 ID는 Gmail 주소가 됩니다. 이름·전화번호는 Google 로그인 후
            입력합니다.
          </p>
          <p className="text-center text-xs text-neutral-500">
            이미 계정이 있으신가요?{" "}
            <Link href="/login/parent" className="text-[#4a90e2] underline">
              로그인
            </Link>
          </p>
        </form>
      ) : null}
    </>
  );
}

export default function ParentJoinPage() {
  return (
    <div className="min-h-[100dvh] bg-background px-4 py-10 flex flex-col items-center justify-center">
      <div
        className="glass-card-hero w-full max-w-[400px] p-8"
        style={{ WebkitBackdropFilter: "blur(24px) saturate(1.2)" }}
      >
        <h1 className="text-center text-xl font-semibold text-foreground">학부모 가입</h1>
        <p className="mt-1 text-center text-xs text-neutral-500">attn.</p>
        <div className="mt-6">
          <Suspense
            fallback={
              <ProcessStatusModal
                open={true}
                title="학원 정보 확인 중"
                description="가입할 학원 이름을 확인하고 있어요."
              />
            }
          >
            <ParentJoinForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
