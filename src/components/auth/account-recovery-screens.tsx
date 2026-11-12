"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { LoginPasswordField } from "@/components/auth/login-password-field";
import { LegalLinks } from "@/components/legal/legal-links";
import { PhoneVerificationStep } from "@/components/phone-verification/phone-verification-step";
import {
  memberLoginHref,
  readRecoveryRole,
  RECOVERY_TEXT,
  type RecoveryRole,
} from "@/lib/auth/account-recovery-text";
import { ensureAppCheck, oneShotCallable } from "@/lib/firebase/app-check";
import { formatKrPhoneInput, KR_PHONE_INPUT_MAX_LENGTH } from "@/lib/phone/kr-phone";
import { octomoPhoneKey } from "@/lib/phone/octomo-phone-key";
import { signupErrorMessage } from "@/lib/signup/signup-errors";

/**
 * 아이디 찾기·비밀번호 찾기(2-M, L3-2·M1) — 직원·학부모 로그인 화면 아래 링크에서 들어온다.
 * 휴대폰 번호를 문자로 확인(OCTOMO, 목적 `find_login_id`·`reset_password`)한 뒤 서버가 판단한다.
 * App Check는 [인증 문자 받기] 뒤 번호 확인 부품이 처음 켠다(화면을 열기만 하면 0회). 찾기 함수는 1회용 토큰.
 * `?role=`은 돌아가기·로그인 이동에만 쓴다(서버 판단은 역할과 무관).
 */

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3.5 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50 focus:bg-white/70 focus:shadow-[0_0_0_3px_rgba(74,144,226,0.18)]";
const btnPrimary =
  "w-full rounded-2xl bg-[#222] py-3.5 text-[15px] font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-950";
const btnSecondary =
  "block w-full rounded-2xl border border-neutral-300/70 py-3 text-center text-sm font-medium text-neutral-700 dark:text-neutral-200";
const linkClass = "font-medium text-[#4a90e2] underline-offset-2 hover:underline";

function useRecoveryRole(): RecoveryRole | null {
  return readRecoveryRole(useSearchParams().get("role"));
}

function RecoveryShell({ title, role, children }: { title: string; role: RecoveryRole | null; children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-4 py-10 pb-[max(2rem,env(safe-area-inset-bottom))]">
      <div className="glass-card-hero w-full max-w-[400px] p-6 sm:p-8" style={{ WebkitBackdropFilter: "blur(24px) saturate(1.2)" }}>
        <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="mt-2 text-center text-xs text-neutral-500">attn.</p>
        <div className="mt-6">{children}</div>
        <p className="mt-8 break-keep text-center text-[11px] leading-relaxed text-neutral-500">{RECOVERY_TEXT.ownerNote}</p>
        <p className="mt-3 text-center text-xs">
          <Link href={role ? memberLoginHref(role) : "/login"} className={linkClass}>
            로그인 화면으로
          </Link>
        </p>
      </div>
      <LegalLinks className="mt-6" />
    </div>
  );
}

function PhoneInput({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-neutral-600">
        휴대폰 번호
      </label>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="tel"
        value={value}
        maxLength={KR_PHONE_INPUT_MAX_LENGTH}
        onChange={(e) => onChange(formatKrPhoneInput(e.target.value))}
        placeholder="010-0000-0000"
        className={`${inputClass} font-mono`}
      />
    </div>
  );
}

function Alert({ tone, children }: { tone: "error" | "ok"; children: ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`break-keep rounded-2xl px-3 py-2.5 text-center text-sm ring-1 ${
        tone === "error"
          ? "bg-red-500/10 text-red-800 ring-red-500/15 dark:text-red-300"
          : "bg-emerald-500/10 text-emerald-900 ring-emerald-500/15 dark:text-emerald-300"
      }`}
    >
      {children}
    </p>
  );
}

type FoundAccount = {
  kind: RecoveryRole;
  academyName: string;
  loginId: string | null;
  google: boolean;
  inactive: boolean;
};

/** 아이디 찾기 — 번호 → 문자 확인 → 그 번호로 확인된 모든 계정(학원·종류·아이디 전체) */
export function FindLoginIdScreen() {
  const role = useRecoveryRole();
  const [phone, setPhone] = useState("");
  const [phase, setPhase] = useState<"input" | "verify" | "loading" | "result" | "error">("input");
  const [accounts, setAccounts] = useState<FoundAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const phoneOk = octomoPhoneKey(phone) !== "";

  const run = async (proof: string) => {
    setPhase("loading");
    try {
      await ensureAppCheck();
      const res = await oneShotCallable<unknown, { status: "ok"; accounts: FoundAccount[] }>("findLoginIdsByPhone")({
        phone,
        phoneProof: proof,
      });
      setAccounts(res.data.accounts ?? []);
      setPhase("result");
    } catch (e) {
      setError(signupErrorMessage(e, "아이디를 찾지 못했어요. 처음부터 다시 해 주세요."));
      setPhase("error");
    }
  };

  const restart = () => {
    setPhase("input");
    setError(null);
    setAccounts([]);
  };

  return (
    <RecoveryShell title="아이디 찾기" role={role}>
      {phase === "input" ? (
        <div className="space-y-4" data-recovery="find-input">
          <p className="break-keep text-center text-sm text-neutral-600">
            가입할 때 문자로 확인한 휴대폰 번호로 아이디를 찾아요.
          </p>
          <PhoneInput id="find-phone" value={phone} onChange={setPhone} />
          <button type="button" disabled={!phoneOk} onClick={() => setPhase("verify")} className={btnPrimary}>
            인증 문자 받기
          </button>
          <p className="text-center text-xs text-neutral-500">
            비밀번호를 잊으셨나요?{" "}
            <Link href={`/login/reset-password${role ? `?role=${role}` : ""}`} className={linkClass}>
              비밀번호 찾기
            </Link>
          </p>
        </div>
      ) : null}

      {phase === "verify" ? (
        <PhoneVerificationStep
          purpose="find_login_id"
          phone={phone}
          allowSkip={false}
          unavailableText={RECOVERY_TEXT.unavailable}
          onVerifiedAction={(proof) => void run(proof)}
          onEditPhoneAction={() => setPhase("input")}
        />
      ) : null}

      {phase === "loading" ? <p className="text-center text-sm text-neutral-500">아이디를 찾는 중…</p> : null}

      {phase === "result" ? (
        <div className="space-y-3" data-recovery="find-result">
          {accounts.length === 0 ? (
            <Alert tone="error">{RECOVERY_TEXT.findNone}</Alert>
          ) : (
            <>
              <p className="text-center text-sm text-neutral-600">이 번호로 확인된 계정이에요.</p>
              <ul className="space-y-2">
                {accounts.map((a, i) => (
                  <li
                    key={`${a.kind}-${a.academyName}-${a.loginId ?? "g"}-${i}`}
                    className="rounded-2xl bg-white/60 px-4 py-3 ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10"
                    data-recovery-account
                  >
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 rounded-full bg-neutral-900/[0.06] px-2 py-0.5 text-[11px] font-medium text-neutral-700 dark:bg-white/10 dark:text-neutral-200">
                        {a.kind === "parent" ? "학부모" : "직원"}
                      </span>
                      <span className="min-w-0 truncate text-sm font-medium text-foreground">{a.academyName}</span>
                    </div>
                    <p className="mt-1.5 break-all font-mono text-base text-foreground">
                      {a.google ? <span className="font-sans text-sm">Google로 로그인</span> : a.loginId}
                    </p>
                    {a.inactive ? (
                      <p className="mt-1 break-keep text-xs text-red-700 dark:text-red-300">{RECOVERY_TEXT.inactive}</p>
                    ) : (
                      <Link
                        href={memberLoginHref(a.kind, a.google ? null : a.loginId)}
                        className="mt-2 inline-block text-xs font-medium text-[#4a90e2]"
                      >
                        로그인하러 가기 →
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          <button type="button" onClick={restart} className={btnSecondary}>
            다른 번호로 찾기
          </button>
        </div>
      ) : null}

      {phase === "error" ? (
        <div className="space-y-3">
          <Alert tone="error">{error}</Alert>
          <button type="button" onClick={restart} className={btnSecondary}>
            처음부터 다시
          </button>
        </div>
      ) : null}
    </RecoveryShell>
  );
}

type VerifyRes = { status: "ok"; ticket: string; expiresAtMs: number } | { status: "google" | "no_match" | "limited" };
type ResetRes = { status: "ok"; role: RecoveryRole; loginId: string } | { status: "expired" | "no_match" };

/** 비밀번호 찾기 — 아이디 + 번호 → 문자 확인 → 서버 판단 → 새 비밀번호(다른 기기 로그인 끊김·잠금 해제) */
export function ResetPasswordScreen() {
  const role = useRecoveryRole();
  const [loginId, setLoginId] = useState("");
  const [phone, setPhone] = useState("");
  const [phase, setPhase] = useState<"input" | "verify" | "checking" | "password" | "saving" | "done" | "failed">("input");
  const [ticket, setTicket] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [done, setDone] = useState<{ role: RecoveryRole; loginId: string } | null>(null);
  const canStart = loginId.trim() !== "" && octomoPhoneKey(phone) !== "";

  const fail = (text: string) => {
    setMessage(text);
    setPhase("failed");
  };

  const verify = async (proof: string) => {
    setPhase("checking");
    try {
      await ensureAppCheck();
      const res = await oneShotCallable<unknown, VerifyRes>("verifyPasswordResetTarget")({
        loginId: loginId.trim(),
        phone,
        phoneProof: proof,
      });
      const d = res.data;
      if (d.status === "ok") {
        setTicket(d.ticket);
        setPhase("password");
        return;
      }
      fail(d.status === "google" ? RECOVERY_TEXT.google : d.status === "limited" ? RECOVERY_TEXT.limited : RECOVERY_TEXT.noMatch);
    } catch (e) {
      fail(signupErrorMessage(e, RECOVERY_TEXT.noMatch));
    }
  };

  const save = async () => {
    setPwError(null);
    if (pw.length < 6) {
      setPwError("새 비밀번호는 6자 이상이어야 합니다.");
      return;
    }
    if (pw !== pw2) {
      setPwError("새 비밀번호가 서로 달라요.");
      return;
    }
    if (!ticket) return;
    setPhase("saving");
    try {
      await ensureAppCheck();
      const res = await oneShotCallable<unknown, ResetRes>("resetPasswordWithPhone")({ ticket, newPassword: pw });
      const d = res.data;
      if (d.status === "ok") {
        setDone({ role: d.role, loginId: d.loginId });
        setPhase("done");
        return;
      }
      fail(d.status === "expired" ? RECOVERY_TEXT.expired : RECOVERY_TEXT.noMatch);
    } catch (e) {
      setPwError(signupErrorMessage(e, "비밀번호를 바꾸지 못했어요. 다시 시도해 주세요."));
      setPhase("password");
    }
  };

  const restart = () => {
    setPhase("input");
    setTicket(null);
    setMessage(null);
    setPw("");
    setPw2("");
    setPwError(null);
  };

  return (
    <RecoveryShell title="비밀번호 찾기" role={role}>
      {phase === "input" ? (
        <div className="space-y-4" data-recovery="reset-input">
          <p className="break-keep text-center text-sm text-neutral-600">
            로그인 ID와, 가입할 때 문자로 확인한 휴대폰 번호를 입력해 주세요.
          </p>
          <div>
            <label htmlFor="reset-login-id" className="mb-1.5 block text-xs font-medium text-neutral-600">
              로그인 ID
            </label>
            <input
              id="reset-login-id"
              autoComplete="username"
              value={loginId}
              maxLength={100}
              onChange={(e) => setLoginId(e.target.value)}
              className={inputClass}
            />
          </div>
          <PhoneInput id="reset-phone" value={phone} onChange={setPhone} />
          <button type="button" disabled={!canStart} onClick={() => setPhase("verify")} className={btnPrimary}>
            인증 문자 받기
          </button>
          <p className="text-center text-xs text-neutral-500">
            아이디가 기억나지 않나요?{" "}
            <Link href={`/login/find-id${role ? `?role=${role}` : ""}`} className={linkClass}>
              아이디 찾기
            </Link>
          </p>
        </div>
      ) : null}

      {phase === "verify" ? (
        <PhoneVerificationStep
          purpose="reset_password"
          phone={phone}
          allowSkip={false}
          unavailableText={RECOVERY_TEXT.unavailable}
          onVerifiedAction={(proof) => void verify(proof)}
          onEditPhoneAction={() => setPhase("input")}
        />
      ) : null}

      {phase === "checking" ? <p className="text-center text-sm text-neutral-500">계정을 확인하는 중…</p> : null}

      {phase === "password" || phase === "saving" ? (
        <div className="space-y-4" data-recovery="reset-password">
          <p className="break-keep text-center text-sm text-neutral-600">새 비밀번호를 정해 주세요.</p>
          <LoginPasswordField
            id="reset-new-password"
            label="새 비밀번호(6자 이상)"
            value={pw}
            onChangeAction={setPw}
            visible={showPw}
            onToggleVisibleAction={() => setShowPw((v) => !v)}
            disabled={phase === "saving"}
            inputClassName={inputClass}
          />
          <LoginPasswordField
            id="reset-new-password2"
            label="새 비밀번호 확인"
            value={pw2}
            onChangeAction={setPw2}
            visible={showPw}
            onToggleVisibleAction={() => setShowPw((v) => !v)}
            disabled={phase === "saving"}
            inputClassName={inputClass}
          />
          {pwError ? <Alert tone="error">{pwError}</Alert> : null}
          <button type="button" disabled={phase === "saving"} onClick={() => void save()} className={btnPrimary}>
            {phase === "saving" ? "바꾸는 중…" : "비밀번호 바꾸기"}
          </button>
        </div>
      ) : null}

      {phase === "done" && done ? (
        <div className="space-y-3" data-recovery="reset-done">
          <Alert tone="ok">{RECOVERY_TEXT.resetDone}</Alert>
          <Link href={memberLoginHref(done.role, done.loginId)} className={`${btnPrimary} block text-center`}>
            로그인하러 가기
          </Link>
        </div>
      ) : null}

      {phase === "failed" ? (
        <div className="space-y-3" data-recovery="reset-failed">
          <Alert tone="error">{message}</Alert>
          <button type="button" onClick={restart} className={btnSecondary}>
            처음부터 다시
          </button>
        </div>
      ) : null}
    </RecoveryShell>
  );
}
