"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useState } from "react";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3.5 text-foreground shadow-inner outline-none transition focus:border-[#4a90e2]/50 focus:bg-white/70";

type OverlayPhase = "input" | "loading" | "complete";

type AcademyRegistrationOverlayProps = {
  open: boolean;
  /** 최초 등록 vs 추가 등록 */
  variant: "first" | "add";
  onCloseAction: () => void;
  /** 학원 생성이 성공적으로 끝났을 때 호출 — 목록 갱신용 */
  onAcademyCreatedAction?: () => void;
};

function errMsg(err: unknown): string {
  if (err instanceof FirebaseError) {
    return err.message || "요청에 실패했습니다.";
  }
  return "요청에 실패했습니다.";
}

/**
 * 학원 등록 — 이름만 입력. 학원 공용 로그인이 없으므로 비밀번호를 정하지 않고,
 * 직원 계정은 등록 후 학원 화면의 직원 관리에서 초대하거나 직접 만들어 준다.
 */
export function AcademyRegistrationOverlay({
  open,
  variant,
  onCloseAction,
  onAcademyCreatedAction,
}: AcademyRegistrationOverlayProps) {
  useBodyScrollLock(open);

  const [name, setName] = useState("");
  const [phase, setPhase] = useState<OverlayPhase>("input");
  const [error, setError] = useState<string | null>(null);
  const [academyAttnId, setAcademyAttnId] = useState("");

  const reset = useCallback(() => {
    setName("");
    setPhase("input");
    setError(null);
    setAcademyAttnId("");
  }, []);

  const handleClose = useCallback(() => {
    if (phase === "loading") return;
    reset();
    onCloseAction();
  }, [onCloseAction, phase, reset]);

  useEffect(() => {
    if (!open) {
      reset();
    }
  }, [open, reset]);

  const onSubmit = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("학원 이름을 입력해 주세요.");
      return;
    }
    setError(null);
    setPhase("loading");
    try {
      const create = httpsCallable(getFirebaseFunctions(), "createAcademyEasy");
      const created = await create({ name: trimmed });
      const c = created.data as { academyId?: string; attnId?: string };
      setAcademyAttnId(c.attnId ?? c.academyId ?? "");
      setPhase("complete");
      onAcademyCreatedAction?.();
    } catch (e) {
      setError(errMsg(e));
      setPhase("input");
    }
  }, [name, onAcademyCreatedAction]);

  if (!open) {
    return null;
  }

  const title = variant === "first" ? "학원 등록" : "새 학원 추가";
  const headerTitle = phase === "loading" ? "등록 진행 중" : title;
  const canClose = phase !== "loading";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <header className="shrink-0 border-b border-neutral-200/80 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] dark:border-white/10">
        <div className="mx-auto flex max-w-lg items-center justify-between">
          <h1 className="text-lg font-semibold text-foreground">{headerTitle}</h1>
          {canClose ? (
            <button
              type="button"
              onClick={handleClose}
              className="text-sm text-neutral-500 hover:text-foreground"
            >
              닫기
            </button>
          ) : (
            <span className="text-sm text-neutral-400">처리 중</span>
          )}
        </div>
      </header>

      <main className="flex flex-1 flex-col overflow-hidden">
        {phase === "loading" ? (
          <div className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center px-4 py-8">
            <div
              className="h-12 w-12 rounded-full border-[3px] border-neutral-200 border-t-[#222] animate-spin dark:border-white/20 dark:border-t-white"
              aria-hidden
            />
            <p className="mt-8 text-center text-lg font-semibold text-foreground">학원 생성 중</p>
            <p className="mt-3 text-center text-sm leading-relaxed text-neutral-600">
              학원 정보와 기본 권한을 저장하고 있어요.
            </p>
          </div>
        ) : null}

        {phase === "complete" ? (
          <div className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center px-4 py-8">
            <div className="w-full text-center">
              <p className="text-3xl font-semibold tracking-tight text-emerald-700 dark:text-emerald-400">
                학원 등록 완료!
              </p>
              <p className="mt-4 text-sm leading-relaxed text-neutral-600">
                학원 번호는{" "}
                <span className="font-mono font-medium text-foreground">{academyAttnId}</span>
                입니다.
              </p>
              <p className="mt-3 text-xs leading-relaxed text-neutral-500">
                선생님·직원은 학원 대시보드의 직원 관리에서 초대 링크를 보내거나 계정을 직접 만들어 주세요.
                학부모는 「학부모」 탭의 가입 링크로 직접 가입하도록 안내해 주세요.
              </p>
            </div>
          </div>
        ) : null}

        {phase === "input" ? (
          <div className="mx-auto flex w-full max-w-lg flex-1 flex-col px-4 py-6">
            {error ? (
              <p className="mb-4 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-800">{error}</p>
            ) : null}
            <p className="text-sm text-neutral-600">운영하실 학원 이름을 입력해 주세요.</p>
            <label htmlFor="academy-name" className="mt-6 block text-xs font-medium text-neutral-600">
              학원 이름
            </label>
            <input
              id="academy-name"
              className={`${inputClass} mt-2`}
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onSubmit();
              }}
              placeholder="예: 햇살수학학원"
              autoFocus
            />
          </div>
        ) : null}
      </main>

      {phase !== "loading" ? (
        <footer className="shrink-0 border-t border-neutral-200/80 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] dark:border-white/10">
          <div className="mx-auto flex max-w-lg justify-center">
            <button
              type="button"
              onClick={phase === "complete" ? handleClose : () => void onSubmit()}
              className="w-full max-w-xs rounded-2xl bg-[#222] py-3.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950"
            >
              {phase === "complete" ? "확인" : "등록"}
            </button>
          </div>
        </footer>
      ) : null}
    </div>
  );
}
