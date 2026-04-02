"use client";

import { FirebaseError } from "firebase/app";
import { signOut } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";

function finalizeErrorMessage(err: FirebaseError): string {
  switch (err.code) {
    case "functions/unauthenticated":
      return "로그인이 필요합니다.";
    case "functions/failed-precondition":
      return err.message || "아직 이메일 인증이 완료되지 않았거나, 처리할 수 없는 상태입니다.";
    default:
      return err.message || "요청에 실패했습니다.";
  }
}

export function TeacherCompleteForm() {
  const searchParams = useSearchParams();
  const academyId = searchParams.get("academyId")?.trim() ?? "";
  const showVerifiedBanner = searchParams.get("verified") === "1";

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [already, setAlready] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured()) {
      return;
    }
    const auth = getFirebaseAuth();
    return auth.onAuthStateChanged((u) => {
      setSignedIn(Boolean(u));
      setUserEmail(u?.email ?? null);
      setAuthReady(true);
    });
  }, []);

  const onFinalize = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "finalizeTeacherOnboarding");
      const res = await fn(academyId ? { academyId } : {});
      const data = res.data as { ok?: boolean; alreadyComplete?: boolean };
      if (data?.alreadyComplete) {
        setAlready(true);
      }
      setDone(true);
    } catch (e) {
      if (e instanceof FirebaseError) {
        setError(finalizeErrorMessage(e));
      } else {
        setError("요청에 실패했습니다.");
      }
    } finally {
      setBusy(false);
    }
  }, [academyId]);

  const onSignOutOtherTeacher = useCallback(async () => {
    setError(null);
    try {
      await signOut(getFirebaseAuth());
      setDone(false);
      setAlready(false);
    } catch {
      setError("로그아웃에 실패했습니다.");
    }
  }, []);

  if (!isFirebaseConfigured()) {
    return <p className="text-sm text-neutral-600">Firebase 설정이 필요합니다.</p>;
  }

  if (!authReady) {
    return <p className="text-sm text-neutral-500">불러오는 중…</p>;
  }

  if (!signedIn) {
    return (
      <div className="space-y-4 text-sm text-neutral-700">
        {showVerifiedBanner ? (
          <p className="rounded-xl bg-sky-500/10 px-3 py-2 text-xs text-sky-950 ring-1 ring-sky-500/20">
            이메일 인증은 완료되었습니다. 아래에서 <strong>초청받은 그 이메일</strong>과 설정한 비밀번호로
            로그인한 뒤 &quot;등록 완료 처리&quot;를 진행해 주세요.
          </p>
        ) : (
          <p>
            비밀번호 설정과 이메일 인증을 모두 마쳤다면, 아래에서{" "}
            <strong>초청받은 선생님 이메일</strong>로 로그인한 뒤 &quot;등록 완료 처리&quot;를 눌러 주세요.
          </p>
        )}
        {academyId ? (
          <p className="text-[11px] text-neutral-500">
            학원 ID가 URL에 포함되어 있습니다. 링크를 공유·북마크한 그대로 사용하면 됩니다.
          </p>
        ) : null}
        <Link
          href="/login?role=teacher"
          className="inline-flex w-full justify-center rounded-2xl bg-[#222] py-3 text-center font-medium text-white"
        >
          선생님 로그인
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="space-y-3 text-sm text-neutral-700">
        <p className="font-medium text-emerald-800">
          {already
            ? "현재 로그인한 계정은 이미 등록 대기 상태입니다."
            : "등록 대기 상태로 전환되었습니다. 학원과 확인이 끝나면 활성 처리됩니다."}
        </p>
        {already ? (
          <div className="space-y-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-950 ring-1 ring-amber-500/20">
            <p>
              <strong>다른 선생님</strong> 초청을 이어서 하시는 경우, 다른 계정으로 로그인되어 있지 않은지
              확인해 주세요. (같은 브라우저에 이전 선생님이 로그인된 채로 이메일 인증만 하면, 잘못된
              계정으로 처리될 수 있습니다.)
            </p>
            {userEmail ? (
              <p className="font-mono text-[11px] text-neutral-700">지금 로그인: {userEmail}</p>
            ) : null}
            <button
              type="button"
              onClick={() => void onSignOutOtherTeacher()}
              className="w-full rounded-xl border border-amber-700/30 bg-white/60 py-2 text-xs font-medium text-amber-950"
            >
              로그아웃 후 다른 선생님으로 진행
            </button>
          </div>
        ) : null}
        {!already ? (
          <p className="text-xs text-neutral-500">
            학원 대시보드에서는 해당 선생님이 &quot;등록대기&quot;로 표시됩니다.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-700">
        초청 메일의 <strong>비밀번호 설정</strong>과 <strong>이메일 인증</strong>을 모두 완료했다면,
        아래 버튼으로 학원에 &quot;등록 대기&quot; 상태를 알립니다.
      </p>
      {userEmail ? (
        <p className="text-[11px] text-neutral-500">
          로그인 계정: <span className="font-mono text-neutral-700">{userEmail}</span>
        </p>
      ) : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => void onFinalize()}
        className="w-full rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-60"
      >
        {busy ? "처리 중…" : "등록 완료 처리"}
      </button>
    </div>
  );
}
