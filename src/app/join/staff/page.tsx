"use client";

import { FirebaseError } from "firebase/app";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { GoogleMark } from "@/components/auth/google-mark";
import {
  ConsentChecklist,
  CONSENT_REQUIRED_MESSAGE,
  consentComplete,
  EMPTY_CONSENT,
  type ConsentState,
} from "@/components/legal/consent-checklist";
import { PhoneVerificationStep } from "@/components/phone-verification/phone-verification-step";
import { KrPhoneInput } from "@/components/ui/kr-phone-input";
import { PasswordInput } from "@/components/ui/password-input";
import { ProcessStatusModal } from "@/components/ui/process-status-modal";
import { ensureAppCheck, oneShotCallable } from "@/lib/firebase/app-check";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { currentConsentPayload } from "@/lib/legal/legal-docs";
import { getMemberLoginIdFormatError } from "@/lib/member-login-id";
import { formatKrPhoneInput, getKrPhoneValidationError } from "@/lib/phone/kr-phone";
import { readSignupToken, signupErrorMessage, SIGNUP_LINK_INVALID_MESSAGE } from "@/lib/signup/signup-errors";
import { resolvePasswordConfirmHint } from "@/lib/ui/password-confirm-hint";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3.5 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";
const labelClass = "mb-1.5 block text-xs font-medium text-neutral-600";
const primaryBtn = "w-full rounded-2xl bg-[#222] py-3.5 text-[15px] font-medium text-white disabled:opacity-50";
const secondaryBtn = "w-full rounded-2xl border border-neutral-300/70 py-3 text-sm font-medium text-neutral-700";
const MAX_NAME_LENGTH = 60;
const STAFF_SKIP_NOTE = "번호 확인 없이 가입하면 학원이 승인한 뒤 이용할 수 있어요.";

type LoginIdStatus = "idle" | "checking" | "available" | "unavailable";
type Method = "password" | "google";
type Step = "profile" | "verify" | "finish";
type PhoneCheck = { phone: string; proof: string | null };
type Done = { loginId: string; active: boolean };

/**
 * 직원 가입(`/join/staff?token=…`, 2-K 토큰 + 2-L 번호 확인) — 학원이 공유한 공용 직원 가입 QR로만 가입한다.
 * 단계: 이름·휴대폰 번호 → 휴대폰 번호 확인(건너뛰기 가능) → 로그인 ID·비밀번호·동의(Google은 동의만).
 * 결과는 "가입 승인 대기"(학원 승인 필요), 번호가 확인되고 학원이 미리 등록한 직원과 맞으면 바로 사용(2-L).
 * App Check는 로그인 ID 확인·번호 확인·가입 함수를 처음 부르기 직전에만 켠다(가입은 1회용 토큰).
 */
function StaffJoinForm() {
  const searchParams = useSearchParams();
  const token = readSignupToken(searchParams.get("token"));

  const [academyName, setAcademyName] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(token ? null : SIGNUP_LINK_INVALID_MESSAGE);
  const [sessionUser, setSessionUser] = useState<User | null>(null);
  const [method, setMethod] = useState<Method>("password");
  const [step, setStep] = useState<Step>("profile");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneCheck, setPhoneCheck] = useState<PhoneCheck | null>(null);
  const [loginId, setLoginId] = useState("");
  const [loginIdStatus, setLoginIdStatus] = useState<LoginIdStatus>("idle");
  const [loginIdMessage, setLoginIdMessage] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPassword2, setShowPassword2] = useState(false);
  const [confirmBlurred, setConfirmBlurred] = useState(false);
  const [consent, setConsent] = useState<ConsentState>(EMPTY_CONSENT);
  const [googleEmail, setGoogleEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

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
    if (method !== "password" || step !== "finish") return;
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
          await ensureAppCheck();
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
  }, [loginId, token, method, step]);

  const onProfileNext = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const name = displayName.trim();
    if (!name) return setError("이름을 입력해 주세요.");
    if (name.length > MAX_NAME_LENGTH) return setError(`이름은 ${MAX_NAME_LENGTH}자 이하로 입력해 주세요.`);
    const pe = getKrPhoneValidationError(phone);
    if (pe) return setError(pe);
    const formatted = formatKrPhoneInput(phone);
    if (phoneCheck && phoneCheck.phone === formatted) {
      setStep("finish");
      return;
    }
    setPhoneCheck(null);
    setStep("verify");
  };

  /** Google 1단계 — 로그인만 하고 이름·번호를 받는다(가입 함수는 마지막 단계에서) */
  const onGoogleStart = useCallback(async () => {
    setError(null);
    setBusy("Google 계정 확인 중");
    const auth = getFirebaseAuth();
    try {
      const cred = await signInWithPopup(auth, new GoogleAuthProvider());
      setGoogleEmail(cred.user.email ?? "");
      setDisplayName((prev) => prev.trim() || cred.user.displayName || "");
      setMethod("google");
      setStep("profile");
    } catch (err) {
      await signOut(auth).catch(() => undefined);
      setError(signupErrorMessage(err, "Google 로그인을 하지 못했습니다."));
    } finally {
      setBusy(null);
    }
  }, []);

  const onGoogleCancel = async () => {
    setError(null);
    setMethod("password");
    setStep("profile");
    setGoogleEmail("");
    setPhoneCheck(null);
    await signOut(getFirebaseAuth()).catch(() => undefined);
  };

  const onFinish = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!phoneCheck) {
      setStep("verify");
      return;
    }
    if (method === "password") {
      if (loginIdStatus !== "available") return setError(loginIdMessage ?? "로그인 ID를 확인해 주세요.");
      if (password.length < 6) return setError("비밀번호는 6자 이상이어야 합니다.");
      if (password !== password2) return setError("비밀번호가 서로 일치하지 않습니다.");
    }
    if (!consentComplete(consent)) return setError(CONSENT_REQUIRED_MESSAGE);
    setBusy("가입 신청 중");
    try {
      await ensureAppCheck();
      const res = await oneShotCallable<unknown, { loginId?: string; membershipStatus?: string }>("registerStaffSignup")({
        token,
        method,
        displayName: displayName.trim(),
        phone: phoneCheck.phone,
        consents: currentConsentPayload(),
        ...(phoneCheck.proof ? { phoneProof: phoneCheck.proof } : {}),
        ...(method === "password" ? { loginId, password } : {}),
      });
      setDone({
        loginId: method === "password" ? (res.data.loginId ?? loginId) : "",
        active: res.data.membershipStatus === "active",
      });
      if (method === "google") {
        // 로그인 화면에서 다시 로그인(활성이면 새 클레임으로, 승인 대기면 대기 안내)
        await signOut(getFirebaseAuth()).catch(() => undefined);
      }
    } catch (err) {
      if (err instanceof FirebaseError && /번호 확인을 다시/.test(err.message)) setPhoneCheck(null);
      setError(signupErrorMessage(err, "가입에 실패했습니다."));
    } finally {
      setBusy(null);
    }
  };

  const passwordConfirmHint = resolvePasswordConfirmHint(password, password2, confirmBlurred);
  // Google 가입 중에는 방금 로그인한 Google 세션을 쓰므로 막지 않음
  const blockedBySession = Boolean(sessionUser) && !done && method === "password";
  const disabled = blockedBySession || busy !== null;

  if (done) {
    return (
      <div className="text-center" data-signup-done>
        <p className="text-2xl font-semibold tracking-tight text-emerald-700">
          {done.active ? "가입 완료" : "가입 신청 완료"}
        </p>
        <p className="mt-4 break-keep text-sm leading-relaxed text-neutral-600" data-signup-done-message>
          {done.active
            ? "번호를 확인했고 학원이 미리 등록한 정보와 맞아 바로 이용할 수 있어요. 로그인해 주세요."
            : `${academyName ?? "학원"}에서 승인하면 바로 이용할 수 있어요.`}
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

      {step === "profile" ? (
        <form className="mt-6 space-y-4" onSubmit={onProfileNext} noValidate data-signup-step="profile">
          {method === "google" ? (
            <p className="text-center text-xs text-neutral-500">
              Google 계정 <span className="font-mono text-foreground">{googleEmail || "(이메일 없음)"}</span>으로 가입합니다.
            </p>
          ) : null}
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
              disabled={disabled}
            />
          </div>
          <div>
            <label htmlFor="join-phone" className={labelClass}>
              휴대폰 번호 <span className="text-red-600">*</span>
            </label>
            <KrPhoneInput id="join-phone" value={phone} onChange={setPhone} className={inputClass} disabled={disabled} />
            <p className="mt-1 break-keep text-[11px] text-neutral-500">
              학원이 미리 등록해 둔 번호와 같으면 문자 확인 뒤 바로 이용할 수 있어요.
            </p>
          </div>
          <button type="submit" disabled={disabled} className={primaryBtn}>
            다음
          </button>
          {method === "google" ? (
            <button type="button" disabled={busy !== null} onClick={() => void onGoogleCancel()} className={secondaryBtn}>
              다른 방식으로 가입
            </button>
          ) : (
            <>
              <div className="my-2 flex items-center gap-3">
                <span className="h-px flex-1 bg-neutral-300" />
                <span className="shrink-0 text-[11px] text-neutral-500">또는</span>
                <span className="h-px flex-1 bg-neutral-300" />
              </div>
              <button
                type="button"
                disabled={disabled}
                onClick={() => void onGoogleStart()}
                className="flex w-full items-center justify-center gap-3 rounded-2xl border border-neutral-300/70 bg-white/60 py-3.5 text-[15px] font-medium text-foreground disabled:opacity-50"
              >
                <GoogleMark />
                Google 계정으로 가입
              </button>
            </>
          )}
        </form>
      ) : null}

      {step === "verify" ? (
        <div className="mt-6" data-signup-step="verify">
          <PhoneVerificationStep
            purpose="staff_signup"
            token={token}
            phone={formatKrPhoneInput(phone)}
            allowSkip
            skipNote={STAFF_SKIP_NOTE}
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

      {step === "finish" ? (
        <form className="mt-6 space-y-4" onSubmit={(e) => void onFinish(e)} noValidate data-signup-step="finish">
          <p
            className={`break-keep rounded-xl px-3 py-2 text-center text-xs ${
              phoneCheck?.proof ? "bg-emerald-50 text-emerald-800" : "bg-neutral-100 text-neutral-600"
            }`}
            data-phone-verified={phoneCheck?.proof ? "yes" : "no"}
          >
            {phoneCheck?.proof
              ? `${phoneCheck.phone} · 번호 확인됨`
              : `${phoneCheck?.phone ?? ""} · 번호 확인 없이 가입(학원 승인 필요)`}
          </p>
          {method === "password" ? (
            <>
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
                  disabled={disabled}
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
                disabled={disabled}
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
                disabled={disabled}
                autoComplete="new-password"
              />
            </>
          ) : (
            <p className="text-center text-xs text-neutral-500">
              Google 계정 <span className="font-mono text-foreground">{googleEmail || "(이메일 없음)"}</span>으로 가입합니다.
            </p>
          )}
          <ConsentChecklist audience="staff" value={consent} onChangeAction={setConsent} disabled={busy !== null} />
          <button type="submit" disabled={disabled} className={primaryBtn}>
            가입 신청
          </button>
          <button type="button" disabled={busy !== null} onClick={() => setStep("profile")} className={secondaryBtn}>
            이름·번호 고치기
          </button>
        </form>
      ) : null}

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
