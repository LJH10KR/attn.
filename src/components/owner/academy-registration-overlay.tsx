"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useState } from "react";
import { PasswordInput } from "@/components/ui/password-input";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { resolvePasswordConfirmHint } from "@/lib/ui/password-confirm-hint";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3.5 text-foreground shadow-inner outline-none transition focus:border-[#4a90e2]/50 focus:bg-white/70";

type LoadPhase = "idle" | "academy" | "teachers" | "done";
type OverlayPhase = "input" | "loading" | "complete";

const PROVISION_STEPS = [
  { id: 1, label: "학원 생성" },
  { id: 2, label: "선생님 계정" },
] as const;

type AcademyRegistrationOverlayProps = {
  open: boolean;
  /** 최초 등록 vs 추가 등록 */
  variant: "first" | "add";
  onCloseAction: () => void;
};

const INPUT_STEPS = [
  { id: 1, label: "학원" },
  { id: 2, label: "선생님" },
  { id: 3, label: "비밀번호" },
] as const;

function errMsg(err: unknown): string {
  if (err instanceof FirebaseError) {
    return err.message || "요청에 실패했습니다.";
  }
  return "요청에 실패했습니다.";
}

function parseTeacherCountInput(raw: string): number {
  if (raw.trim() === "") {
    return 0;
  }
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    return 0;
  }
  return Math.min(50, Math.max(0, n));
}

export function AcademyRegistrationOverlay({
  open,
  variant,
  onCloseAction,
}: AcademyRegistrationOverlayProps) {
  useBodyScrollLock(open);

  const [step, setStep] = useState(1);
  const [slideKey, setSlideKey] = useState(0);
  const [name, setName] = useState("");
  const [teacherCountStr, setTeacherCountStr] = useState("0");
  const [portalPassword, setPortalPassword] = useState("");
  const [portalPassword2, setPortalPassword2] = useState("");
  const [showPortalPassword, setShowPortalPassword] = useState(false);
  const [showPortalPassword2, setShowPortalPassword2] = useState(false);
  const [confirmBlurred, setConfirmBlurred] = useState(false);
  const [phase, setPhase] = useState<OverlayPhase>("input");
  const [loadPhase, setLoadPhase] = useState<LoadPhase>("idle");
  const [teacherProgressCurrent, setTeacherProgressCurrent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [academyAttnId, setAcademyAttnId] = useState("");
  const [teacherCountIssued, setTeacherCountIssued] = useState(0);

  const reset = useCallback(() => {
    setStep(1);
    setSlideKey(0);
    setName("");
    setTeacherCountStr("0");
    setPortalPassword("");
    setPortalPassword2("");
    setShowPortalPassword(false);
    setShowPortalPassword2(false);
    setConfirmBlurred(false);
    setPhase("input");
    setLoadPhase("idle");
    setTeacherProgressCurrent(0);
    setError(null);
    setAcademyAttnId("");
    setTeacherCountIssued(0);
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

  const goStep = useCallback((next: number) => {
    setSlideKey((k) => k + 1);
    setStep(next);
    setError(null);
  }, []);

  const teacherCount = parseTeacherCountInput(teacherCountStr);

  const passwordConfirmHint = resolvePasswordConfirmHint(
    portalPassword,
    portalPassword2,
    confirmBlurred,
  );

  const onSubmit = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("학원 이름을 입력해 주세요.");
      return;
    }
    if (portalPassword.length < 6) {
      setError("학원 비밀번호는 6자 이상이어야 합니다.");
      return;
    }
    if (portalPassword !== portalPassword2) {
      setError("비밀번호가 서로 일치하지 않습니다.");
      return;
    }

    setError(null);
    setPhase("loading");
    setLoadPhase("academy");
    const fn = getFirebaseFunctions();

    try {
      const create = httpsCallable(fn, "createAcademyEasy");
      const created = await create({ name: trimmed, portalPassword });
      const c = created.data as { academyId?: string; attnId?: string };
      const aid = c.academyId ?? "";
      setAcademyAttnId(c.attnId ?? aid);

      if (teacherCount > 0) {
        setLoadPhase("teachers");
        const tFn = httpsCallable(fn, "provisionTemplateTeachers");
        let issued = 0;
        for (let i = 1; i <= teacherCount; i++) {
          setTeacherProgressCurrent(i);
          await tFn({ academyId: aid, count: 1 });
          issued += 1;
        }
        setTeacherCountIssued(issued);
      } else {
        setTeacherCountIssued(0);
      }

      setLoadPhase("done");
      setPhase("complete");
    } catch (e) {
      setError(errMsg(e));
      setPhase("input");
      setLoadPhase("idle");
    }
  }, [name, portalPassword, portalPassword2, teacherCount]);

  if (!open) {
    return null;
  }

  const title = variant === "first" ? "학원 등록" : "새 학원 추가";
  const headerTitle = phase === "loading" ? "등록 진행 중" : title;
  const canClose = phase !== "loading";

  const provisionStepActive =
    loadPhase === "academy" ? 1 : loadPhase === "teachers" ? 2 : loadPhase === "done" ? 3 : 0;

  const loadingStatusTitle =
    loadPhase === "academy"
      ? "1단계 · 학원 생성 중"
      : loadPhase === "teachers"
        ? "2단계 · 선생님 계정 생성 중"
        : null;

  const loadingStatusDetail =
    loadPhase === "academy"
      ? "학원 정보와 로그인 설정을 저장하고 있어요."
      : loadPhase === "teachers" && teacherCount > 0
        ? `${teacherProgressCurrent} / ${teacherCount}번째 선생님 계정을 생성하고 있어요.`
        : loadPhase === "teachers"
          ? "선생님 계정을 건너뛰고 마무리하고 있어요."
          : null;

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
        {phase === "input" ? (
          <nav
            className="mx-auto mt-4 flex max-w-lg items-center justify-between gap-1"
            aria-label="등록 단계"
          >
            {INPUT_STEPS.map((s, i) => {
              const active = step === s.id;
              const done = step > s.id;
              return (
                <div key={s.id} className="flex flex-1 items-center gap-1">
                  <div className="flex flex-col items-center flex-1 min-w-0">
                    <span
                      className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                        active
                          ? "bg-[#222] text-white dark:bg-neutral-100 dark:text-neutral-950"
                          : done
                            ? "bg-emerald-500/15 text-emerald-800 ring-1 ring-emerald-500/30"
                            : "bg-neutral-200/80 text-neutral-500 dark:bg-white/10"
                      }`}
                    >
                      {done ? "✓" : s.id}
                    </span>
                    <span
                      className={`mt-1 truncate text-[10px] font-medium ${
                        active ? "text-foreground" : "text-neutral-500"
                      }`}
                    >
                      {s.label}
                    </span>
                  </div>
                  {i < INPUT_STEPS.length - 1 ? (
                    <div
                      className={`mb-4 h-0.5 flex-1 max-w-[2rem] rounded transition-colors ${
                        done ? "bg-emerald-400/60" : "bg-neutral-200 dark:bg-white/10"
                      }`}
                    />
                  ) : null}
                </div>
              );
            })}
          </nav>
        ) : null}
        {phase === "loading" ? (
          <nav
            className="mx-auto mt-4 flex max-w-lg items-center justify-between gap-1"
            aria-label="생성 진행 단계"
          >
            {PROVISION_STEPS.map((s, i) => {
              const active = provisionStepActive === s.id;
              const done = provisionStepActive > s.id;
              const skipped = s.id === 2 && teacherCount === 0 && loadPhase !== "academy";
              return (
                <div key={s.id} className="flex flex-1 items-center gap-1">
                  <div className="flex flex-col items-center flex-1 min-w-0">
                    <span
                      className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                        active
                          ? "bg-[#222] text-white dark:bg-neutral-100 dark:text-neutral-950"
                          : done || skipped
                            ? "bg-emerald-500/15 text-emerald-800 ring-1 ring-emerald-500/30"
                            : "bg-neutral-200/80 text-neutral-500 dark:bg-white/10"
                      }`}
                    >
                      {done || skipped ? "✓" : s.id}
                    </span>
                    <span
                      className={`mt-1 truncate text-[10px] font-medium ${
                        active ? "text-foreground" : "text-neutral-500"
                      }`}
                    >
                      {s.label}
                    </span>
                  </div>
                  {i < PROVISION_STEPS.length - 1 ? (
                    <div
                      className={`mb-4 h-0.5 flex-1 max-w-[2rem] rounded transition-colors ${
                        done || skipped ? "bg-emerald-400/60" : "bg-neutral-200 dark:bg-white/10"
                      }`}
                    />
                  ) : null}
                </div>
              );
            })}
          </nav>
        ) : null}
      </header>

      <main className="flex flex-1 flex-col overflow-hidden">
        {phase === "loading" ? (
          <div className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center px-4 py-8">
            <div
              className="h-12 w-12 rounded-full border-[3px] border-neutral-200 border-t-[#222] animate-spin dark:border-white/20 dark:border-t-white"
              aria-hidden
            />
            {loadingStatusTitle ? (
              <p className="mt-8 text-center text-lg font-semibold text-foreground">
                {loadingStatusTitle}
              </p>
            ) : null}
            {loadingStatusDetail ? (
              <p className="mt-3 text-center text-sm leading-relaxed text-neutral-600">
                {loadingStatusDetail}
              </p>
            ) : null}
            {loadPhase === "teachers" && teacherCount > 0 ? (
              <div className="mt-6 w-full max-w-xs">
                <div className="h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-white/10">
                  <div
                    className="h-full rounded-full bg-[#222] transition-all duration-300 dark:bg-neutral-100"
                    style={{
                      width: `${Math.round((teacherProgressCurrent / teacherCount) * 100)}%`,
                    }}
                  />
                </div>
                <p className="mt-2 text-center text-xs text-neutral-500">
                  {teacherProgressCurrent} / {teacherCount}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {phase === "complete" ? (
          <div className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center px-4 py-8">
            <div className="w-full text-center">
              <p className="text-3xl font-semibold tracking-tight text-emerald-700 dark:text-emerald-400">
                학원 등록 완료!
              </p>
              <p className="mt-4 text-sm leading-relaxed text-neutral-600">
                학원 로그인 번호는{" "}
                <span className="font-mono font-medium text-foreground">{academyAttnId}</span>
                입니다.
                {teacherCountIssued > 0
                  ? ` 선생님 ${teacherCountIssued}명의 계정이 발급되었습니다.`
                  : " 선생님은 학원 대시보드에서 나중에 추가할 수 있습니다."}
              </p>
              <p className="mt-3 text-xs text-neutral-500">
                학부모는 학원 대시보드 「학부모」 탭의 가입 링크로 직접 가입하도록 안내해 주세요.
              </p>
            </div>
          </div>
        ) : null}

        {phase === "input" ? (
        <div
          key={slideKey}
          className="mx-auto flex w-full max-w-lg flex-1 flex-col px-4 py-6 transition-opacity duration-300"
        >
          {error ? (
            <p className="mb-4 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-800">{error}</p>
          ) : null}

          {step === 1 ? (
            <div className="flex flex-1 flex-col">
              <p className="text-sm text-neutral-600">운영하실 학원 이름을 입력해 주세요.</p>
              <label className="mt-6 block text-xs font-medium text-neutral-600">학원 이름</label>
              <input
                className={`${inputClass} mt-2`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="예: 햇살수학학원"
                autoFocus
              />
            </div>
          ) : null}

          {step === 2 ? (
            <div className="flex flex-1 flex-col">
              <p className="text-sm text-neutral-600">
                지금 발급할 선생님 계정 수를 입력해 주세요. 0명이면 나중에 학원 대시보드에서
                추가할 수 있습니다.
              </p>
              <label className="mt-6 block text-xs font-medium text-neutral-600">
                선생님 계정 수 (0~50)
              </label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                className={`${inputClass} mt-2`}
                value={teacherCountStr}
                onFocus={() => setTeacherCountStr("")}
                onBlur={() => {
                  const n = parseTeacherCountInput(teacherCountStr);
                  setTeacherCountStr(String(n));
                }}
                onChange={(e) => {
                  const digits = e.target.value.replace(/\D/g, "");
                  if (digits === "") {
                    setTeacherCountStr("");
                    return;
                  }
                  const n = Math.min(50, Number.parseInt(digits, 10));
                  setTeacherCountStr(String(n));
                }}
                placeholder="0"
              />
            </div>
          ) : null}

          {step === 3 ? (
            <div className="flex flex-1 flex-col">
              <p className="text-sm text-neutral-600">
                학원 포털 로그인에 사용할 비밀번호를 정해 주세요.
              </p>
              <PasswordInput
                id="portal-password"
                label="비밀번호"
                value={portalPassword}
                onChangeAction={setPortalPassword}
                visible={showPortalPassword}
                onToggleVisibleAction={() => setShowPortalPassword((v) => !v)}
                inputClassName={inputClass}
                labelClassName="mt-6 block text-xs font-medium text-neutral-600"
              />
              <PasswordInput
                id="portal-password-confirm"
                label="비밀번호 확인"
                value={portalPassword2}
                onChangeAction={setPortalPassword2}
                onBlurAction={() => setConfirmBlurred(true)}
                visible={showPortalPassword2}
                onToggleVisibleAction={() => setShowPortalPassword2((v) => !v)}
                confirmHint={passwordConfirmHint}
                inputClassName={inputClass}
                labelClassName="mt-6 block text-xs font-medium text-neutral-600"
              />
            </div>
          ) : null}
        </div>
        ) : null}
      </main>

      {phase === "input" ? (
      <footer className="shrink-0 border-t border-neutral-200/80 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] dark:border-white/10">
        <div
          className={`mx-auto flex max-w-lg gap-2 ${step > 1 ? "" : "justify-center"}`}
        >
          {step > 1 ? (
            <button
              type="button"
              onClick={() => goStep(step - 1)}
              className="flex-1 rounded-2xl border border-neutral-300/70 py-3.5 text-sm font-medium"
            >
              이전
            </button>
          ) : null}
          {step < 3 ? (
            <button
              type="button"
              onClick={() => {
                if (step === 1 && !name.trim()) {
                  setError("학원 이름을 입력해 주세요.");
                  return;
                }
                goStep(step + 1);
              }}
              className={`rounded-2xl bg-[#222] py-3.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950 ${
                step > 1 ? "flex-1" : "w-full max-w-xs"
              }`}
            >
              다음
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void onSubmit()}
              className={`rounded-2xl bg-[#222] py-3.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950 ${
                step > 1 ? "flex-1" : "w-full max-w-xs"
              }`}
            >
              등록
            </button>
          )}
        </div>
      </footer>
      ) : null}

      {phase === "complete" ? (
        <footer className="shrink-0 border-t border-neutral-200/80 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] dark:border-white/10">
          <div className="mx-auto flex max-w-lg justify-center">
            <button
              type="button"
              onClick={handleClose}
              className="w-full max-w-xs rounded-2xl bg-[#222] py-3.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950"
            >
              확인
            </button>
          </div>
        </footer>
      ) : null}
    </div>
  );
}
