"use client";

import { FirebaseError } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  updateProfile,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { GoogleMark } from "@/components/auth/google-mark";
import { SignupCompleteModal } from "@/components/auth/signup-complete-modal";
import { PasswordInput } from "@/components/ui/password-input";
import { ProcessStatusModal } from "@/components/ui/process-status-modal";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";
import {
  fetchOwnerSignupProfileState,
  upsertOwnerProfile,
} from "@/lib/firebase/owner-profile";
import {
  formatKrPhoneInput,
  getKrPhoneValidationError,
  KR_PHONE_INPUT_MAX_LENGTH,
} from "@/lib/phone/kr-phone";
import { resolvePasswordConfirmHint } from "@/lib/ui/password-confirm-hint";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3.5 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50 focus:bg-white/70";

type SignupStep = "form" | "google_profile";

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
  const [signupStep, setSignupStep] = useState<SignupStep>("form");
  const [googleEmail, setGoogleEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPassword2, setShowPassword2] = useState(false);
  const [confirmBlurred, setConfirmBlurred] = useState(false);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingModal, setLoadingModal] = useState<{
    title: string;
    description?: string;
  } | null>(null);
  const [signupCompleteOpen, setSignupCompleteOpen] = useState(false);

  const configured = isFirebaseConfigured();
  const passwordConfirmHint = resolvePasswordConfirmHint(password, password2, confirmBlurred);
  const formDisabled = busy || googleBusy || loadingModal !== null;

  const onEmailSignup = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!configured) {
        setError("Firebase 환경 변수를 먼저 설정해 주세요.");
        return;
      }
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
        const cred = await createUserWithEmailAndPassword(auth, em, password);
        const trimmedName = displayName.trim();
        const formattedPhone = formatKrPhoneInput(phone);
        await updateProfile(cred.user, { displayName: trimmedName });
        await upsertOwnerProfile(cred.user, {
          displayName: trimmedName,
          phone: formattedPhone,
        });
        setSignupCompleteOpen(true);
        void httpsCallable(getFirebaseFunctions(), "issueEmailVerificationOtp")({ purpose: "owner" }).catch(
          () => {},
        );
      } catch (err) {
        const code = err instanceof FirebaseError ? err.code : "";
        setError(signupErrorMessage(code));
      } finally {
        setBusy(false);
      }
    },
    [configured, displayName, email, password, password2, phone],
  );

  const onGoogleSignup = useCallback(async () => {
    setError(null);
    if (!configured) {
      setError("Firebase 환경 변수를 먼저 설정해 주세요.");
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
      const result = await signInWithPopup(auth, provider);
      const user = result.user;
      const state = await fetchOwnerSignupProfileState(user.uid);

      if (state.profileComplete) {
        setLoadingModal(null);
        router.replace("/owner");
        return;
      }

      const suggested =
        (typeof user.displayName === "string" ? user.displayName.trim() : "") ||
        state.suggestedDisplayName;
      setGoogleEmail(user.email ?? state.email ?? "");
      setDisplayName(suggested);
      if (state.isOwner && state.suggestedDisplayName) {
        /* 기존 오너 문서가 있으나 전화번호 등 미완료 — 전화만 비울 수 있음 */
        setPhone("");
      }
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
  }, [configured, router]);

  const onGoogleProfileBack = useCallback(async () => {
    setError(null);
    setSignupStep("form");
    setGoogleEmail("");
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
      const auth = getFirebaseAuth();
      const user = auth.currentUser;
      if (!user) {
        setError("Google 로그인 후 다시 시도해 주세요.");
        return;
      }
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
      setBusy(true);
      setLoadingModal({
        title: "오너 계정 등록 중",
        description: "이름·연락처를 저장하고 가입을 마무리하고 있어요.",
      });
      try {
        const trimmedName = displayName.trim();
        const formattedPhone = formatKrPhoneInput(phone);
        await updateProfile(user, { displayName: trimmedName });
        await upsertOwnerProfile(user, {
          displayName: trimmedName,
          phone: formattedPhone,
        });
        setLoadingModal(null);
        router.replace("/owner");
      } catch (err) {
        setLoadingModal(null);
        setError(err instanceof FirebaseError ? err.message : "가입에 실패했습니다.");
      } finally {
        setBusy(false);
      }
    },
    [displayName, phone, router],
  );

  return (
    <div className="min-h-[100dvh] bg-background px-4 py-10 flex flex-col items-center justify-center pb-[max(2rem,env(safe-area-inset-bottom))]">
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
          void signOut(getFirebaseAuth()).finally(() => {
            router.replace("/login/owner");
          });
        }}
      />

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
          {signupStep === "google_profile" ? "추가 정보 입력" : "회원가입"}
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

        {signupStep === "google_profile" ? (
          <form className="mt-6 space-y-4" onSubmit={(e) => void onGoogleComplete(e)} noValidate>
            <p className="text-center text-xs text-neutral-600">
              Google 가입을 마치려면 이름과 휴대폰 번호를 입력해 주세요.
            </p>
            <div>
              <label
                className="mb-1.5 block text-xs font-medium text-neutral-600"
                htmlFor="signup-google-email"
              >
                Google 이메일
              </label>
              <input
                id="signup-google-email"
                type="email"
                className={`${inputClass} bg-neutral-100/80 dark:bg-white/5`}
                value={googleEmail}
                readOnly
                disabled
              />
            </div>
            <div>
              <label
                className="mb-1.5 block text-xs font-medium text-neutral-600"
                htmlFor="signup-g-name"
              >
                이름 <span className="text-red-600">*</span>
              </label>
              <input
                id="signup-g-name"
                className={inputClass}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={60}
                autoComplete="name"
                required
                disabled={formDisabled}
              />
            </div>
            <div>
              <label
                className="mb-1.5 block text-xs font-medium text-neutral-600"
                htmlFor="signup-g-phone"
              >
                휴대폰 번호 <span className="text-red-600">*</span>
              </label>
              <input
                id="signup-g-phone"
                type="tel"
                className={inputClass}
                value={phone}
                onChange={(e) => setPhone(formatKrPhoneInput(e.target.value))}
                maxLength={KR_PHONE_INPUT_MAX_LENGTH}
                autoComplete="tel"
                inputMode="numeric"
                required
                disabled={formDisabled}
                placeholder="010-1234-5678"
              />
            </div>
            <button
              type="submit"
              disabled={formDisabled}
              className="w-full rounded-2xl bg-[#222] dark:bg-neutral-100 py-3.5 text-[15px] font-medium text-white dark:text-neutral-950 disabled:opacity-50"
            >
              가입 완료
            </button>
            <button
              type="button"
              disabled={formDisabled}
              onClick={() => void onGoogleProfileBack()}
              className="w-full rounded-2xl border border-neutral-300/70 py-3 text-sm font-medium text-neutral-700 disabled:opacity-50"
            >
              다른 방식으로 가입
            </button>
          </form>
        ) : (
          <>
            <form className="mt-6 space-y-4" onSubmit={onEmailSignup} noValidate>
              <div>
                <label
                  className="mb-1.5 block text-xs font-medium text-neutral-600"
                  htmlFor="signup-name"
                >
                  이름 <span className="text-red-600">*</span>
                </label>
                <input
                  id="signup-name"
                  className={inputClass}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={60}
                  autoComplete="name"
                  required
                  disabled={formDisabled}
                />
              </div>
              <div>
                <label
                  className="mb-1.5 block text-xs font-medium text-neutral-600"
                  htmlFor="signup-phone"
                >
                  휴대폰 번호 <span className="text-red-600">*</span>
                </label>
                <input
                  id="signup-phone"
                  type="tel"
                  className={inputClass}
                  value={phone}
                  onChange={(e) => setPhone(formatKrPhoneInput(e.target.value))}
                  maxLength={KR_PHONE_INPUT_MAX_LENGTH}
                  autoComplete="tel"
                  inputMode="numeric"
                  required
                  disabled={formDisabled}
                  placeholder="010-1234-5678"
                />
              </div>
              <div>
                <label
                  className="mb-1.5 block text-xs font-medium text-neutral-600"
                  htmlFor="signup-email"
                >
                  이메일 <span className="text-red-600">*</span>
                </label>
                <input
                  id="signup-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputClass}
                  placeholder="name@example.com"
                  required
                  disabled={formDisabled}
                />
              </div>
              <PasswordInput
                id="signup-password"
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
                labelClassName="mb-1.5 block text-xs font-medium text-neutral-600"
                disabled={formDisabled}
                required
                minLength={8}
              />
              <PasswordInput
                id="signup-password2"
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
                labelClassName="mb-1.5 block text-xs font-medium text-neutral-600"
                disabled={formDisabled}
                required
                minLength={8}
              />
              <button
                type="submit"
                disabled={formDisabled || !configured}
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
              disabled={formDisabled || !configured}
              onClick={() => void onGoogleSignup()}
              className="flex w-full items-center justify-center gap-3 rounded-2xl border border-neutral-300/70 bg-white/60 dark:border-white/12 dark:bg-white/10 py-3.5 text-[15px] font-medium text-foreground shadow-sm backdrop-blur-md transition hover:bg-white/85 active:scale-[0.99] disabled:opacity-50"
            >
              <GoogleMark />
              Google로 오너 가입
            </button>

            <p className="mt-4 text-center text-xs leading-relaxed text-neutral-500">
              Google 가입 시 이름·전화번호는 Google 로그인 후 입력합니다.
            </p>

            <p className="mt-4 text-center text-xs leading-relaxed text-neutral-500">
              이메일 가입 시 메일함의 링크로 인증을 완료한 뒤 로그인할 수 있습니다.
            </p>
          </>
        )}

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
    </div>
  );
}
