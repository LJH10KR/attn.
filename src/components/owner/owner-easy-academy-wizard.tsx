"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useCallback, useState } from "react";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

type IssuedTeacher = {
  attnId: string;
  displayName: string;
  tempPassword: string;
};

type IssuedParent = {
  attnId: string;
  displayName: string;
  tempPassword: string;
  children: Array<{ attnId: string; name: string }>;
};

type OwnerEasyAcademyWizardProps = {
  open: boolean;
  onCloseAction: () => void;
};

type LoadStep = "idle" | "academy" | "teachers" | "parents" | "done";

function errMsg(err: unknown): string {
  if (err instanceof FirebaseError) {
    return err.message || "요청에 실패했습니다.";
  }
  return "요청에 실패했습니다.";
}

export function OwnerEasyAcademyWizard({ open, onCloseAction }: OwnerEasyAcademyWizardProps) {
  useBodyScrollLock(open);

  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [teacherCount, setTeacherCount] = useState(2);
  const [parentCount, setParentCount] = useState(2);
  const [portalPassword, setPortalPassword] = useState("");
  const [portalPassword2, setPortalPassword2] = useState("");
  const [loadStep, setLoadStep] = useState<LoadStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [academyAttnId, setAcademyAttnId] = useState("");
  const [academyPortalPassword, setAcademyPortalPassword] = useState("");
  const [teachers, setTeachers] = useState<IssuedTeacher[]>([]);
  const [parents, setParents] = useState<IssuedParent[]>([]);

  const reset = useCallback(() => {
    setStep(1);
    setName("");
    setTeacherCount(2);
    setParentCount(2);
    setPortalPassword("");
    setPortalPassword2("");
    setLoadStep("idle");
    setError(null);
    setAcademyAttnId("");
    setAcademyPortalPassword("");
    setTeachers([]);
    setParents([]);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onCloseAction();
  }, [onCloseAction, reset]);

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
    setLoadStep("academy");
    const fn = getFirebaseFunctions();

    try {
      const create = httpsCallable(fn, "createAcademyEasy");
      const created = await create({ name: trimmed, portalPassword });
      const c = created.data as {
        academyId?: string;
        attnId?: string;
        portalPassword?: string;
      };
      const aid = c.academyId ?? "";
      setAcademyAttnId(c.attnId ?? aid);
      setAcademyPortalPassword(c.portalPassword ?? portalPassword);

      setLoadStep("teachers");
      const tFn = httpsCallable(fn, "provisionTemplateTeachers");
      const tRes = await tFn({ academyId: aid, count: teacherCount });
      const tData = tRes.data as { teachers?: IssuedTeacher[] };
      setTeachers(tData.teachers ?? []);

      setLoadStep("parents");
      const pFn = httpsCallable(fn, "provisionTemplateParents");
      const pRes = await pFn({
        academyId: aid,
        count: parentCount,
        childrenPerParent: 2,
      });
      const pData = pRes.data as { parents?: IssuedParent[] };
      setParents(pData.parents ?? []);

      setLoadStep("done");
      setStep(4);
    } catch (e) {
      setError(errMsg(e));
      setLoadStep("idle");
    }
  }, [name, parentCount, portalPassword, portalPassword2, teacherCount]);

  if (!open) {
    return null;
  }

  const loading = loadStep !== "idle" && loadStep !== "done";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div className="glass-card max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-3xl p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-foreground">학원 간편 등록</h2>
          <button
            type="button"
            disabled={loading}
            onClick={handleClose}
            className="text-sm text-neutral-500 hover:text-foreground disabled:opacity-40"
          >
            닫기
          </button>
        </div>

        {error ? (
          <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-800">{error}</p>
        ) : null}

        {step === 4 ? (
          <div className="mt-4 space-y-4 text-sm">
            <p className="font-medium text-emerald-800">등록이 완료되었습니다.</p>
            <p className="text-neutral-600">
              아래 로그인 정보는 <strong>이번에만</strong> 표시됩니다. 비밀번호는 각 계정이 최초
              로그인 후 변경하면 활성화됩니다.
            </p>
            <section className="rounded-2xl bg-white/50 p-3 ring-1 ring-black/5">
              <h3 className="text-xs font-semibold text-neutral-500">학원 포털</h3>
              <p className="mt-1 font-mono text-xs">
                로그인 번호: {academyAttnId}
                <br />
                비밀번호: {academyPortalPassword}
              </p>
            </section>
            {teachers.length > 0 ? (
              <section className="rounded-2xl bg-white/50 p-3 ring-1 ring-black/5">
                <h3 className="text-xs font-semibold text-neutral-500">선생님</h3>
                <ul className="mt-2 space-y-2">
                  {teachers.map((t) => (
                    <li key={t.attnId} className="font-mono text-[11px] leading-relaxed">
                      {t.displayName} · {t.attnId} · {t.tempPassword}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {parents.length > 0 ? (
              <section className="rounded-2xl bg-white/50 p-3 ring-1 ring-black/5">
                <h3 className="text-xs font-semibold text-neutral-500">학부모</h3>
                <ul className="mt-2 space-y-2">
                  {parents.map((p) => (
                    <li key={p.attnId} className="font-mono text-[11px] leading-relaxed">
                      {p.displayName} · {p.attnId} · {p.tempPassword}
                      {p.children.length > 0 ? (
                        <span className="block text-neutral-500">
                          자녀: {p.children.map((c) => c.attnId).join(", ")}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <button
              type="button"
              onClick={handleClose}
              className="w-full rounded-2xl bg-[#222] py-3 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950"
            >
              확인
            </button>
          </div>
        ) : loading ? (
          <div className="mt-8 space-y-3 text-sm text-neutral-600">
            <p className={loadStep === "academy" ? "font-medium text-foreground" : ""}>
              {loadStep === "academy" ? "▸ " : "✓ "}학원 생성
            </p>
            <p className={loadStep === "teachers" ? "font-medium text-foreground" : ""}>
              {loadStep === "teachers" ? "▸ " : loadStep === "parents" ? "✓ " : "○ "}
              선생님 계정 발급
            </p>
            <p className={loadStep === "parents" ? "font-medium text-foreground" : ""}>
              {loadStep === "parents" ? "▸ " : "○ "}
              학부모·자녀 발급
            </p>
          </div>
        ) : (
          <>
            <p className="mt-2 text-xs text-neutral-500">단계 {step} / 3</p>

            {step === 1 ? (
              <div className="mt-4 space-y-3">
                <label className="block text-xs font-medium text-neutral-600">학원 이름</label>
                <input
                  className={inputClass}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="예: 햇살수학학원"
                />
              </div>
            ) : null}

            {step === 2 ? (
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-neutral-600">선생님 수</label>
                  <input
                    type="number"
                    min={0}
                    max={50}
                    className={inputClass}
                    value={teacherCount}
                    onChange={(e) => setTeacherCount(Number(e.target.value))}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-600">학부모 수</label>
                  <input
                    type="number"
                    min={0}
                    max={50}
                    className={inputClass}
                    value={parentCount}
                    onChange={(e) => setParentCount(Number(e.target.value))}
                  />
                </div>
                <p className="col-span-2 text-xs text-neutral-500">
                  학부모당 자녀 2명이 자동 생성됩니다.
                </p>
              </div>
            ) : null}

            {step === 3 ? (
              <div className="mt-4 space-y-3">
                <label className="block text-xs font-medium text-neutral-600">학원 포털 비밀번호</label>
                <input
                  type="password"
                  className={inputClass}
                  value={portalPassword}
                  onChange={(e) => setPortalPassword(e.target.value)}
                />
                <label className="block text-xs font-medium text-neutral-600">비밀번호 확인</label>
                <input
                  type="password"
                  className={inputClass}
                  value={portalPassword2}
                  onChange={(e) => setPortalPassword2(e.target.value)}
                />
              </div>
            ) : null}

            <div className="mt-6 flex gap-2">
              {step > 1 ? (
                <button
                  type="button"
                  onClick={() => setStep((s) => s - 1)}
                  className="flex-1 rounded-2xl border border-neutral-300/70 py-3 text-sm font-medium"
                >
                  이전
                </button>
              ) : null}
              {step < 3 ? (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    if (step === 1 && !name.trim()) {
                      setError("학원 이름을 입력해 주세요.");
                      return;
                    }
                    setStep((s) => s + 1);
                  }}
                  className="flex-1 rounded-2xl bg-[#222] py-3 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950"
                >
                  다음
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void onSubmit()}
                  className="flex-1 rounded-2xl bg-[#222] py-3 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950"
                >
                  등록 시작
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
