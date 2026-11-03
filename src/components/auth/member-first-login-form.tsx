"use client";

import { FirebaseError } from "firebase/app";
import { onAuthStateChanged, signInWithCustomToken, signOut, type User } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PasswordInput } from "@/components/ui/password-input";
import { resolveStaffLanding } from "@/lib/academy/staff-landing";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { clearSessionDecisionCaches } from "@/lib/firebase/resolve-session-dashboard";
import { resolvePasswordConfirmHint } from "@/lib/ui/password-confirm-hint";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

const primaryButtonClass =
  "block w-full rounded-2xl bg-[#222] py-3 text-center text-sm font-medium text-white disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-950";

type MemberFirstLoginFormProps = {
  role: "teacher" | "parent";
};

type CompleteFirstLoginResponse = {
  ok?: boolean;
  membershipStatus?: string;
  /** 다른 세션을 끊은 뒤 이 기기가 다시 로그인할 토큰(2-H) */
  customToken?: string;
};

/** 이 화면에서 더 할 수 없어 로그인 화면으로 보내는 안내 */
type DoneNotice = "relogin" | "already";

const DONE_MESSAGES: Record<DoneNotice, string> = {
  relogin: "비밀번호는 설정되었습니다. 새 비밀번호로 다시 로그인해 주세요.",
  already: "이미 비밀번호가 설정된 계정입니다. 새 비밀번호로 로그인해 주세요.",
};

/** 서버 `completeMemberFirstLogin`이 첫 로그인 전 계정이 아닐 때 주는 문구(같은 failed-precondition의 다른 경우와 구분) */
const ALREADY_SET_SERVER_MSG = "첫 로그인 비밀번호 설정이 필요한 계정이 아닙니다";

function errorMessage(err: FirebaseError): string {
  switch (err.code) {
    case "functions/invalid-argument":
      return err.message || "비밀번호를 확인해 주세요.";
    case "functions/unauthenticated":
      return "로그인이 필요합니다.";
    default:
      return err.message || "요청에 실패했습니다.";
  }
}

/**
 * 학원이 직접 만들어 준 계정의 첫 비밀번호 설정(`/teacher/setup`·`/parent/setup`).
 * 인증 복원을 기다린 뒤 폼을 보이고, 완료하면 서버가 다른 세션을 모두 끊은 뒤 준 새 토큰으로 다시 로그인해 이동한다.
 */
export function MemberFirstLoginForm({ role }: MemberFirstLoginFormProps) {
  const router = useRouter();
  const configured = isFirebaseConfigured();
  const [authUser, setAuthUser] = useState<User | null | undefined>(undefined);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPassword2, setShowPassword2] = useState(false);
  const [confirmBlurred, setConfirmBlurred] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<DoneNotice | null>(null);

  useEffect(() => {
    if (!configured) return;
    return onAuthStateChanged(getFirebaseAuth(), (user) => setAuthUser(user));
  }, [configured]);

  const passwordConfirmHint = resolvePasswordConfirmHint(password, password2, confirmBlurred);
  const loginHref = `/login/${role}`;

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (password.length < 6) {
        setError("비밀번호는 6자 이상이어야 합니다.");
        return;
      }
      if (password !== password2) {
        setError("비밀번호가 서로 일치하지 않습니다.");
        return;
      }
      setBusy(true);
      const auth = getFirebaseAuth();
      let res: CompleteFirstLoginResponse;
      try {
        const fn = httpsCallable(getFirebaseFunctions(), "completeMemberFirstLogin");
        res = ((await fn({ newPassword: password })).data ?? {}) as CompleteFirstLoginResponse;
      } catch (err) {
        if (
          err instanceof FirebaseError &&
          err.code === "functions/failed-precondition" &&
          err.message.includes(ALREADY_SET_SERVER_MSG)
        ) {
          // 이미 설정한 계정(뒤로 가기·다른 탭 등) — 새 비밀번호로 다시 로그인하게 세션을 정리
          await signOut(auth).catch(() => undefined);
          setDone("already");
        } else if (err instanceof FirebaseError) {
          setError(errorMessage(err));
        } else {
          setError("요청에 실패했습니다.");
        }
        setBusy(false);
        return;
      }

      try {
        const uid = auth.currentUser?.uid;
        if (res.customToken) {
          // 서버가 이 기기 세션도 끊었으므로 새 토큰으로 다시 로그인(같은 계정)
          await signInWithCustomToken(auth, res.customToken);
        }
        if (uid) clearSessionDecisionCaches(uid);
      } catch {
        // 비밀번호·상태는 이미 바뀌어 다시 호출할 수 없음 — 새 비밀번호로 로그인하도록 안내
        await signOut(auth).catch(() => undefined);
        setDone("relogin");
        setBusy(false);
        return;
      }

      try {
        if (role === "parent") {
          router.replace("/parent");
          return;
        }
        // 직원은 볼 수 있는 학원 메뉴가 있으면 학원 5탭 — 새 토큰의 클레임에 학원 ID가 있음
        const user = auth.currentUser;
        const academyId = await user
          ?.getIdTokenResult()
          .then(({ claims }) => (typeof claims.academyId === "string" ? claims.academyId : ""))
          .catch(() => "");
        router.replace(user && academyId ? await resolveStaffLanding(user, academyId) : "/teacher");
      } finally {
        setBusy(false);
      }
    },
    [password, password2, role, router],
  );

  const label = role === "teacher" ? "선생님" : "학부모";

  if (done) {
    return (
      <div className="space-y-4">
        <p className="rounded-xl bg-[#4a90e2]/10 px-3 py-2 text-sm text-foreground break-keep" role="status">
          {DONE_MESSAGES[done]}
        </p>
        <Link href={loginHref} className={primaryButtonClass}>
          로그인 화면으로
        </Link>
      </div>
    );
  }

  if (configured && authUser === undefined) {
    return <p className="py-6 text-center text-sm text-neutral-500">불러오는 중…</p>;
  }

  if (!configured || authUser === null) {
    return (
      <div className="space-y-4">
        <p className="text-center text-sm text-neutral-700 break-keep">
          로그인이 필요합니다. 학원에서 받은 로그인 ID와 임시 비밀번호로 먼저 로그인해 주세요.
        </p>
        <Link href={loginHref} className={primaryButtonClass}>
          로그인
        </Link>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={(e) => void onSubmit(e)}>
      <p className="text-sm text-neutral-700">
        최초 로그인입니다. <strong>{label}</strong> 계정 비밀번호를 새로 설정해 주세요. 설정이
        완료되면 바로 이용할 수 있습니다.
      </p>
      {error ? (
        <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      ) : null}
      <PasswordInput
        id={`${role}-setup-pw`}
        label={
          <>
            새 비밀번호 <span className="text-red-600">*</span>
          </>
        }
        value={password}
        onChangeAction={setPassword}
        visible={showPassword}
        onToggleVisibleAction={() => setShowPassword((v) => !v)}
        inputClassName={inputClass}
        labelClassName="mb-1.5 block text-xs font-medium text-neutral-600"
        disabled={busy}
        required
        minLength={6}
        autoComplete="new-password"
      />
      <PasswordInput
        id={`${role}-setup-pw2`}
        label={
          <>
            새 비밀번호 확인 <span className="text-red-600">*</span>
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
        disabled={busy}
        required
        minLength={6}
        autoComplete="new-password"
      />
      <button type="submit" disabled={busy} className={primaryButtonClass}>
        {busy ? "저장 중…" : "비밀번호 설정 완료"}
      </button>
      <p className="text-center text-xs text-neutral-500">
        <Link href={loginHref} className="text-[#4a90e2] hover:underline">
          로그인 화면으로
        </Link>
      </p>
    </form>
  );
}
