"use client";

import { FirebaseError } from "firebase/app";
import { GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { PasswordInput } from "@/components/ui/password-input";
import { GoogleMark } from "@/components/auth/google-mark";
import { ProcessStatusModal } from "@/components/ui/process-status-modal";
import {
  ConsentChecklist,
  CONSENT_REQUIRED_MESSAGE,
  consentComplete,
  EMPTY_CONSENT,
  type ConsentState,
} from "@/components/legal/consent-checklist";
import { PhoneVerificationStep } from "@/components/phone-verification/phone-verification-step";
import { resolvePasswordConfirmHint } from "@/lib/ui/password-confirm-hint";
import { ensureAppCheck, oneShotCallable } from "@/lib/firebase/app-check";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { currentConsentPayload } from "@/lib/legal/legal-docs";
import {
  formatKrPhoneInput,
  getKrPhoneValidationError,
  KR_PHONE_INPUT_MAX_LENGTH,
} from "@/lib/phone/kr-phone";
import {
  getParentLoginIdFormatError,
  normalizeParentLoginId,
} from "@/lib/parent-login-id";
import { readSignupToken, signupErrorMessage, SIGNUP_LINK_INVALID_MESSAGE } from "@/lib/signup/signup-errors";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3.5 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";
const labelClass = "mb-1.5 block text-xs font-medium text-neutral-600";
const primaryBtn =
  "w-full rounded-2xl bg-[#222] py-3.5 text-[15px] font-medium text-white disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-950";
const secondaryBtn = "w-full rounded-2xl border border-neutral-300/70 py-3 text-sm font-medium text-neutral-700";

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

type Method = "password" | "google";
type Step = "profile" | "verify" | "finish";
/** 번호 확인 결과 — 증표(확인됨) 또는 건너뜀 */
type PhoneCheck = { phone: string; proof: string | null };
type Done = { loginId: string; method: Method; phoneVerified: boolean; linkedCount: number };

const PARENT_SKIP_NOTE = "번호 확인 없이 가입하면 학원이 확인한 뒤 자녀와 연결돼요.";

/** 가입 완료 안내 — 번호 확인·자동 연결 결과별 */
function parentSignupDoneMessage(d: Pick<Done, "phoneVerified" | "linkedCount">): string {
  if (d.phoneVerified && d.linkedCount > 0) {
    return `번호를 확인해 자녀 ${d.linkedCount}명과 연결했어요. 바로 이용할 수 있어요.`;
  }
  if (d.phoneVerified) {
    return "번호를 확인했어요. 학원에 등록된 보호자 번호와 맞으면 자동으로 연결돼요.";
  }
  return "학원 승인 후 자녀가 연결됩니다. 연결 전에는 학부모 홈에 연결 대기 안내가 보입니다.";
}

/**
 * 학부모 가입(`/join/parent?token=…`, 2-K 토큰 + 2-L 번호 확인) — 학원이 공유한 가입 QR의 무작위 토큰으로만 가입한다.
 * 단계: 이름·휴대폰 번호 → 휴대폰 번호 확인(OCTOMO, 건너뛰기 가능) → 로그인 ID·비밀번호·동의(Google은 동의만).
 * 이메일·이메일 인증 코드는 받지 않는다. 토큰이 없거나(예전 `?academyId=` 주소 포함) 형식이 틀리면 서버를 부르지 않고 바로 안내.
 * App Check는 로그인 ID 확인·번호 확인·가입 함수를 처음 부르기 직전에만 켠다(가입은 1회용 토큰).
 */
function ParentJoinForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = readSignupToken(searchParams.get("token"));

  const [academyName, setAcademyName] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [method, setMethod] = useState<Method>("password");
  const [step, setStep] = useState<Step>("profile");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneCheck, setPhoneCheck] = useState<PhoneCheck | null>(null);
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
  const [consent, setConsent] = useState<ConsentState>(EMPTY_CONSENT);
  const [error, setError] = useState<string | null>(null);
  const [googleLoginId, setGoogleLoginId] = useState("");
  const [done, setDone] = useState<Done | null>(null);
  const [copied, setCopied] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [loadingModal, setLoadingModal] = useState<{
    title: string;
    description?: string;
  } | null>(null);

  useEffect(() => {
    if (!token || !isFirebaseConfigured()) {
      setLoadErr(token ? null : SIGNUP_LINK_INVALID_MESSAGE);
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
        const res = await fn({ token });
        const data = res.data as { name?: string };
        if (!cancelled) {
          setAcademyName(data.name ?? "학원");
          setLoadErr(null);
          setLoadingModal(null);
        }
      } catch (e) {
        if (!cancelled) {
          setLoadErr(signupErrorMessage(e, "학원 정보를 불러오지 못했습니다."));
          setLoadingModal(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (method !== "password" || step !== "finish") return;
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
          await ensureAppCheck();
          const fn = httpsCallable(getFirebaseFunctions(), "checkParentLoginIdAvailable");
          await fn({ token, loginId });
          if (!cancelled) {
            setLoginIdStatus("available");
            setLoginIdMessage("사용할 수 있는 로그인 ID입니다.");
          }
        } catch (e) {
          if (!cancelled) {
            const msg = signupErrorMessage(e, "확인에 실패했습니다. 잠시 후 다시 시도해 주세요.");
            setLoginIdStatus(e instanceof FirebaseError && e.code === "functions/already-exists" ? "taken" : "invalid");
            setLoginIdMessage(msg);
          }
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loginId, token, method, step]);

  const passwordConfirmHint = resolvePasswordConfirmHint(password, password2, confirmBlurred);
  const busy = loadingModal !== null;

  /** 1단계 → 번호 확인 — 같은 번호를 이미 확인했으면 바로 마지막 단계 */
  const onProfileNext = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const name = displayName.trim();
    if (!name) return setError("이름을 입력해 주세요.");
    if (name.length > 60) return setError("이름은 60자 이하로 입력해 주세요.");
    const phoneErr = getKrPhoneValidationError(phone);
    if (phoneErr) return setError(phoneErr);
    const formatted = formatKrPhoneInput(phone);
    if (phoneCheck && phoneCheck.phone === formatted) {
      setStep("finish");
      return;
    }
    setPhoneCheck(null);
    setStep("verify");
  };

  const onGoogleSignup = useCallback(async () => {
    setError(null);
    if (!token) return;
    setGoogleBusy(true);
    setLoadingModal({
      title: "Google 계정 연결 중",
      description: "Google 로그인을 확인하고 있어요.",
    });
    try {
      const auth = getFirebaseAuth();
      await signInWithPopup(auth, new GoogleAuthProvider());
      const statusFn = httpsCallable(getFirebaseFunctions(), "getParentSignupGoogleStatus");
      const statusRes = await statusFn({ token });
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
      setDisplayName((prev) => prev.trim() || status.suggestedDisplayName || "");
      setMethod("google");
      setStep("profile");
    } catch (err) {
      const auth = getFirebaseAuth();
      if (auth.currentUser) {
        await signOut(auth).catch(() => undefined);
      }
      setError(signupErrorMessage(err, "Google 가입을 시작하지 못했습니다."));
    } finally {
      setGoogleBusy(false);
      setLoadingModal(null);
    }
  }, [token, router]);

  const onGoogleCancel = useCallback(async () => {
    setError(null);
    setMethod("password");
    setStep("profile");
    setGoogleLoginId("");
    setPhoneCheck(null);
    await signOut(getFirebaseAuth()).catch(() => undefined);
  }, []);

  const onCopyLoginId = useCallback(async () => {
    if (!done) return;
    try {
      await navigator.clipboard.writeText(done.loginId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [done]);

  /** 마지막 단계 — 가입 함수(1회용 App Check 토큰) */
  const onFinish = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!phoneCheck) {
      setStep("verify");
      return;
    }
    if (method === "password") {
      if (!loginId.trim()) return setError("로그인 ID를 입력해 주세요.");
      const formatErr = getParentLoginIdFormatError(loginId);
      if (formatErr) return setError(formatErr);
      if (loginIdStatus !== "available") return setError("사용 가능한 로그인 ID를 입력해 주세요.");
      if (!password) return setError("비밀번호를 입력해 주세요.");
      if (password.length < 6) return setError("비밀번호는 6자 이상이어야 합니다.");
      if (password !== password2) return setError("비밀번호가 서로 일치하지 않습니다.");
    }
    if (!consentComplete(consent)) return setError(CONSENT_REQUIRED_MESSAGE);

    const common = {
      token,
      displayName: displayName.trim(),
      phone: phoneCheck.phone,
      consents: currentConsentPayload(),
      ...(phoneCheck.proof ? { phoneProof: phoneCheck.proof } : {}),
    };
    try {
      setLoadingModal({
        title: "학부모 계정 만드는 중",
        description: "계정 정보를 안전하게 등록하고 있어요.",
      });
      await ensureAppCheck();
      type Res = { loginId?: string; phoneVerified?: boolean; linkedCount?: number };
      const res =
        method === "password"
          ? await oneShotCallable<unknown, Res>("registerParentSelfSignup")({
              ...common,
              loginId: normalizeParentLoginId(loginId),
              password,
            })
          : await oneShotCallable<unknown, Res>("registerParentGoogleSignup")(common);
      setLoadingModal(null);
      setDone({
        loginId: res.data.loginId ?? (method === "password" ? normalizeParentLoginId(loginId) : googleLoginId),
        method,
        phoneVerified: res.data.phoneVerified === true,
        linkedCount: typeof res.data.linkedCount === "number" ? res.data.linkedCount : 0,
      });
    } catch (err) {
      setLoadingModal(null);
      // 증표를 쓸 수 없으면(만료·이미 씀) 번호 확인부터 다시
      if (err instanceof FirebaseError && /번호 확인을 다시/.test(err.message)) {
        setPhoneCheck(null);
      }
      setError(signupErrorMessage(err, "가입에 실패했습니다."));
    }
  };

  if (!isFirebaseConfigured()) {
    return <p className="text-sm text-neutral-600">Firebase 설정이 필요합니다.</p>;
  }

  const ready = !loadErr && token && academyName !== null;

  return (
    <>
      <ProcessStatusModal
        open={loadingModal !== null}
        title={loadingModal?.title ?? ""}
        description={loadingModal?.description}
      />

      {loadErr ? (
        <div className="space-y-4 text-center" data-signup-invalid>
          <p className="break-keep text-sm text-red-700">{loadErr}</p>
          <Link href="/login/parent" className="text-sm text-[#4a90e2] underline">
            학부모 로그인
          </Link>
        </div>
      ) : null}

      {ready && done ? (
        <div className="space-y-4 text-center" data-signup-done>
          <p className="text-lg font-semibold text-emerald-800">가입이 완료되었습니다</p>
          <p className="text-sm text-neutral-600">
            다음부터 로그인할 때 사용할 <strong>로그인 ID</strong>입니다. 꼭 메모해 두세요.
          </p>
          <div className="flex items-center gap-2 rounded-xl bg-white/60 px-3 py-3 ring-1 ring-black/5">
            <p className="min-w-0 flex-1 break-all text-left font-mono text-sm">{done.loginId}</p>
            <button
              type="button"
              onClick={() => void onCopyLoginId()}
              className="shrink-0 rounded-[8px] p-2 text-neutral-500 transition hover:bg-black/5 hover:text-foreground"
              aria-label="로그인 ID 복사"
            >
              <ClipboardIcon />
            </button>
          </div>
          {copied ? <p className="text-xs text-emerald-600">클립보드에 복사했습니다.</p> : null}
          <p className="break-keep text-xs leading-relaxed text-neutral-500" data-signup-done-message>
            {parentSignupDoneMessage(done)}
          </p>
          {done.method === "google" ? (
            <button type="button" onClick={() => router.replace("/parent")} className={primaryBtn}>
              학부모 홈으로
            </button>
          ) : (
            <button
              type="button"
              onClick={() => router.replace(`/login/parent?loginId=${encodeURIComponent(done.loginId)}`)}
              className={primaryBtn}
            >
              로그인하러 가기
            </button>
          )}
        </div>
      ) : null}

      {ready && !done && step === "profile" ? (
        <form className="space-y-4" onSubmit={onProfileNext} noValidate data-signup-step="profile">
          <p className="text-center text-sm text-neutral-600">
            <span className="font-medium text-foreground">{academyName}</span>{" "}
            {method === "google" ? "· Google 가입" : "학부모 회원 가입"}
          </p>
          {error ? (
            <p className="break-keep rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-800" role="alert">
              {error}
            </p>
          ) : null}
          {method === "google" ? (
            <div>
              <label className={labelClass} htmlFor="pj-google-login">
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
          ) : null}
          <div>
            <label className={labelClass} htmlFor="pj-name">
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
              disabled={busy}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="pj-phone">
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
              disabled={busy}
              placeholder="010-1234-5678"
            />
            <p className="mt-1 break-keep text-[11px] text-neutral-500">
              학원에 등록된 보호자 번호와 같으면 문자 확인 뒤 자녀와 바로 연결돼요.
            </p>
          </div>
          <button type="submit" disabled={busy || googleBusy} className={primaryBtn}>
            다음
          </button>

          {method === "google" ? (
            <button type="button" disabled={busy} onClick={() => void onGoogleCancel()} className={secondaryBtn}>
              다른 방식으로 가입
            </button>
          ) : (
            <>
              <div className="flex items-center gap-3 py-1">
                <span className="h-px flex-1 bg-neutral-200 dark:bg-white/10" />
                <span className="shrink-0 text-[11px] text-neutral-500">또는</span>
                <span className="h-px flex-1 bg-neutral-200 dark:bg-white/10" />
              </div>
              <button
                type="button"
                disabled={busy || googleBusy}
                onClick={() => void onGoogleSignup()}
                className="flex w-full items-center justify-center gap-3 rounded-2xl border border-neutral-300/70 bg-white/60 py-3.5 text-[15px] font-medium text-foreground shadow-sm transition hover:bg-white/85 active:scale-[0.99] disabled:opacity-50 dark:border-white/12 dark:bg-white/10"
              >
                <GoogleMark />
                Google로 학부모 가입
              </button>
              <p className="text-center text-xs text-neutral-500">
                Google 가입 시 로그인 ID는 Gmail 주소가 됩니다.
              </p>
            </>
          )}
          <p className="text-center text-xs text-neutral-500">
            이미 계정이 있으신가요?{" "}
            <Link href="/login/parent" className="text-[#4a90e2] underline">
              로그인
            </Link>
          </p>
        </form>
      ) : null}

      {ready && !done && step === "verify" ? (
        <div data-signup-step="verify">
          <PhoneVerificationStep
            purpose="parent_signup"
            token={token}
            phone={formatKrPhoneInput(phone)}
            allowSkip
            skipNote={PARENT_SKIP_NOTE}
            onVerifiedAction={(proof) => {
              setPhoneCheck({ phone: formatKrPhoneInput(phone), proof });
              setStep("finish");
            }}
            onSkipAction={() => {
              setPhoneCheck({ phone: formatKrPhoneInput(phone), proof: null });
              setStep("finish");
            }}
            onEditPhoneAction={() => setStep("profile")}
          />
        </div>
      ) : null}

      {ready && !done && step === "finish" ? (
        <form className="space-y-4" onSubmit={(e) => void onFinish(e)} noValidate data-signup-step="finish">
          <p className="text-center text-sm text-neutral-600">
            <span className="font-medium text-foreground">{academyName}</span>{" "}
            {method === "google" ? "· Google 가입" : "학부모 회원 가입"}
          </p>
          <p
            className={`break-keep rounded-xl px-3 py-2 text-center text-xs ${
              phoneCheck?.proof ? "bg-emerald-50 text-emerald-800" : "bg-neutral-100 text-neutral-600"
            }`}
            data-phone-verified={phoneCheck?.proof ? "yes" : "no"}
          >
            {phoneCheck?.proof
              ? `${phoneCheck.phone} · 번호 확인됨`
              : `${phoneCheck?.phone ?? ""} · 번호 확인 없이 가입(학원 확인 뒤 연결)`}
          </p>
          {error ? (
            <p className="break-keep rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-800" role="alert">
              {error}
            </p>
          ) : null}
          {method === "password" ? (
            <>
              <div>
                <label className={labelClass} htmlFor="pj-login-id">
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
                    disabled={busy}
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
                disabled={busy}
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
                disabled={busy}
                required
                minLength={6}
              />
            </>
          ) : null}
          <ConsentChecklist audience="parent" value={consent} onChangeAction={setConsent} disabled={busy} />
          <button type="submit" disabled={busy} className={primaryBtn}>
            {method === "google" ? "가입 완료" : "가입하기"}
          </button>
          <button type="button" disabled={busy} onClick={() => setStep("profile")} className={secondaryBtn}>
            이름·번호 고치기
          </button>
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
