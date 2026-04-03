"use client";

import { FirebaseError } from "firebase/app";
import {
  applyActionCode,
  confirmPasswordReset,
  signInWithEmailAndPassword,
  signOut,
  verifyPasswordResetCode,
} from "firebase/auth";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { getFirebaseAuth } from "@/lib/firebase/client-app";

/**
 * Firebase 액션 링크의 continueUrl에서 초청 완료 페이지 경로(+쿼리) 복원.
 * 선생님·학부모 모두 Functions에서 동일한 방식으로 continueUrl을 넣으므로 둘 다 허용합니다.
 */
function inviteCompleteHref(searchParams: URLSearchParams): string {
  const enc = searchParams.get("continueUrl");
  if (!enc) {
    return "/teacher/complete";
  }
  try {
    const decoded = decodeURIComponent(enc);
    const base =
      typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:3000";
    const u = new URL(decoded, base);
    const path = u.pathname.replace(/\/$/, "") || "/";
    if (path.endsWith("/teacher/complete") || path.endsWith("/parent/complete")) {
      return `${path}${u.search}`;
    }
  } catch {
    /* ignore */
  }
  return "/teacher/complete";
}

function messageFromFirebase(err: unknown): string {
  if (err instanceof FirebaseError) {
    switch (err.code) {
      case "auth/expired-action-code":
      case "auth/invalid-action-code":
        return "링크가 만료되었거나 이미 사용되었습니다.";
      case "auth/weak-password":
        return "비밀번호가 너무 약합니다. 더 길게 입력해 주세요.";
      default:
        return err.message || "처리에 실패했습니다.";
    }
  }
  return "처리에 실패했습니다.";
}

export function AuthActionForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const mode = searchParams.get("mode");
  const oobCode = searchParams.get("oobCode");

  const [error, setError] = useState<string | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(mode === "verifyEmail");
  const [resetEmail, setResetEmail] = useState<string | null>(null);
  const [resetLoading, setResetLoading] = useState(mode === "resetPassword");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [submitBusy, setSubmitBusy] = useState(false);

  useEffect(() => {
    if (!isFirebaseConfigured() || mode !== "verifyEmail" || !oobCode) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const auth = getFirebaseAuth();
        await applyActionCode(auth, oobCode);
        /** 다른 계정으로 로그인된 채 인증만 하면 세션이 바뀌지 않아 잘못된 계정으로 finalize 됨 */
        await signOut(auth);
        if (!cancelled) {
          const next = inviteCompleteHref(searchParams);
          const joiner = next.includes("?") ? "&" : "?";
          router.replace(`${next}${joiner}verified=1`);
        }
      } catch (e) {
        if (!cancelled) {
          setVerifyBusy(false);
          setError(messageFromFirebase(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, oobCode, router, searchParams]);

  useEffect(() => {
    if (!isFirebaseConfigured() || mode !== "resetPassword" || !oobCode) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const auth = getFirebaseAuth();
        const email = await verifyPasswordResetCode(auth, oobCode);
        if (!cancelled) {
          setResetEmail(email);
        }
      } catch (e) {
        if (!cancelled) {
          setError(messageFromFirebase(e));
        }
      } finally {
        if (!cancelled) {
          setResetLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, oobCode]);

  const onSubmitPassword = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!oobCode) {
        return;
      }
      if (pw.length < 8) {
        setError("비밀번호는 8자 이상으로 입력해 주세요.");
        return;
      }
      if (pw !== pw2) {
        setError("비밀번호가 서로 일치하지 않습니다.");
        return;
      }
      setSubmitBusy(true);
      try {
        const auth = getFirebaseAuth();
        await confirmPasswordReset(auth, oobCode, pw);
        /** Firebase는 비밀번호 설정만 하고 세션을 유지하지 않음 — 바로 로그인해 등록 완료 단계로 이어짐 */
        const email = resetEmail?.trim();
        if (email) {
          try {
            await signInWithEmailAndPassword(auth, email, pw);
          } catch {
            /* 실패 시 완료 페이지에서 수동 로그인 */
          }
        }
        router.replace(inviteCompleteHref(searchParams));
      } catch (err) {
        setError(messageFromFirebase(err));
      } finally {
        setSubmitBusy(false);
      }
    },
    [oobCode, pw, pw2, resetEmail, router, searchParams],
  );

  if (!isFirebaseConfigured()) {
    return (
      <p className="text-sm text-neutral-600">Firebase 설정이 필요합니다.</p>
    );
  }

  if (!mode || !oobCode) {
    return <p className="text-sm text-neutral-600">유효하지 않은 링크입니다.</p>;
  }

  if (mode === "verifyEmail") {
    if (error) {
      return <p className="text-sm text-red-700">{error}</p>;
    }
    return (
      <p className="text-sm text-neutral-600">
        {verifyBusy ? "이메일 인증을 처리하는 중입니다…" : "완료되었습니다. 잠시 후 이동합니다."}
      </p>
    );
  }

  if (mode === "resetPassword") {
    if (resetLoading) {
      return <p className="text-sm text-neutral-600">링크를 확인하는 중입니다…</p>;
    }
    if (error && !resetEmail) {
      return <p className="text-sm text-red-700">{error}</p>;
    }
    return (
      <form onSubmit={onSubmitPassword} className="mt-2 space-y-4">
        {resetEmail ? (
          <p className="text-xs text-neutral-500 break-all">
            계정: <span className="font-mono text-[#111]">{resetEmail}</span>
          </p>
        ) : null}
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="npw">
            새 비밀번호
          </label>
          <input
            id="npw"
            type="password"
            autoComplete="new-password"
            value={pw}
            onChange={(ev) => setPw(ev.target.value)}
            className="w-full rounded-2xl border border-neutral-300/70 bg-white px-4 py-3 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="npw2">
            새 비밀번호 확인
          </label>
          <input
            id="npw2"
            type="password"
            autoComplete="new-password"
            value={pw2}
            onChange={(ev) => setPw2(ev.target.value)}
            className="w-full rounded-2xl border border-neutral-300/70 bg-white px-4 py-3 text-sm"
          />
        </div>
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        <button
          type="submit"
          disabled={submitBusy}
          className="w-full rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-60"
        >
          {submitBusy ? "저장 중…" : "비밀번호 저장"}
        </button>
      </form>
    );
  }

  return <p className="text-sm text-neutral-600">지원하지 않는 작업입니다.</p>;
}
