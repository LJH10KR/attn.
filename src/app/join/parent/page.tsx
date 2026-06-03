"use client";

import { FirebaseError } from "firebase/app";
import { signInWithCustomToken } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { ProcessStatusModal } from "@/components/ui/process-status-modal";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3.5 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

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

function ParentJoinForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const academyId = searchParams.get("academyId")?.trim() ?? "";

  const [academyName, setAcademyName] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneAttnId, setDoneAttnId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loadingModal, setLoadingModal] = useState<{
    title: string;
    description?: string;
  } | null>(null);

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

  const onCopyLoginId = useCallback(async () => {
    if (!doneAttnId) {
      return;
    }
    try {
      await navigator.clipboard.writeText(doneAttnId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [doneAttnId]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!displayName.trim()) {
        setError("이름을 입력해 주세요.");
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
          description: "이름과 비밀번호를 안전하게 등록하고 있어요.",
        });
        const fn = httpsCallable(getFirebaseFunctions(), "registerParentSelfSignup");
        const res = await fn({
          academyId,
          displayName: displayName.trim(),
          password,
          agreeTerms: true,
        });
        const data = res.data as { customToken?: string; attnId?: string };
        if (data.customToken) {
          setLoadingModal({
            title: "2단계 · 로그인 연결 중",
            description: "가입한 계정으로 자동 로그인하고 있어요.",
          });
          await signInWithCustomToken(getFirebaseAuth(), data.customToken);
        }
        setLoadingModal(null);
        setDoneAttnId(data.attnId ?? "");
      } catch (err) {
        setLoadingModal(null);
        setError(err instanceof FirebaseError ? err.message : "가입에 실패했습니다.");
      }
    },
    [academyId, agree, displayName, password, password2],
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

      {!loadErr && academyId && academyName !== null && doneAttnId ? (
        <div className="space-y-4 text-center">
          <p className="text-lg font-semibold text-emerald-800">가입이 완료되었습니다</p>
          <p className="text-sm text-neutral-600">
            다음부터 로그인할 때 사용할 <strong>로그인 번호</strong>입니다. 꼭 메모해 두세요.
          </p>
          <div className="flex items-center gap-2 rounded-xl bg-white/60 px-3 py-3 ring-1 ring-black/5">
            <p className="min-w-0 flex-1 break-all text-left font-mono text-sm">{doneAttnId}</p>
            <button
              type="button"
              onClick={() => void onCopyLoginId()}
              className="shrink-0 rounded-lg p-2 text-neutral-500 transition hover:bg-black/5 hover:text-foreground"
              aria-label="로그인 번호 복사"
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

      {!loadErr && academyId && academyName !== null && !doneAttnId ? (
        <form className="space-y-4" onSubmit={(e) => void onSubmit(e)}>
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
              이름
            </label>
            <input
              id="pj-name"
              className={inputClass}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={60}
              autoComplete="name"
              disabled={loadingModal !== null}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-neutral-600" htmlFor="pj-pw">
              비밀번호
            </label>
            <input
              id="pj-pw"
              type="password"
              className={inputClass}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              disabled={loadingModal !== null}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-neutral-600" htmlFor="pj-pw2">
              비밀번호 확인
            </label>
            <input
              id="pj-pw2"
              type="password"
              className={inputClass}
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              autoComplete="new-password"
              disabled={loadingModal !== null}
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
            가입하기
          </button>
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
