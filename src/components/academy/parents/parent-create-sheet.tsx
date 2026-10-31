"use client";

import { httpsCallable } from "firebase/functions";
import { useEffect, useMemo, useState } from "react";
import { MAX_LINK_STUDENTS } from "@/components/academy/parents/parent-link-sheet";
import { callableMessage, sectionClass } from "@/components/academy/parents/parent-ui";
import { StudentMultiSelect, type StudentMultiSelectPreset } from "@/components/academy/student-multi-select";
import { TempCredentialsDialog } from "@/components/academy/temp-credentials-dialog";
import { KrPhoneInput } from "@/components/ui/kr-phone-input";
import { ModalPortal } from "@/components/ui/modal-portal";
import type { StudentVM } from "@/lib/academy/student-row";
import type { AcademyClassBrief } from "@/lib/academy/use-academy-classes";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { getKrPhoneValidationError } from "@/lib/phone/kr-phone";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

const NAME_MAX = 60;
const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/60 px-4 py-2.5 text-sm text-foreground outline-none placeholder:text-neutral-400 focus:border-[#4a90e2]/50";

type CreateResponse = {
  authUid: string;
  loginId: string;
  displayName: string;
  tempPassword: string;
  linked: string[];
  alreadyLinked: string[];
  failures: { studentId: string; message: string }[];
};

/**
 * 직접 만들어 주기(2-G 보강 B3) — 계정이 하나도 없는 번호 묶음에서만 연다.
 * 이름·번호·자녀를 묶음 값으로 미리 채우고 `createParentAccount`로 계정(첫 로그인 전)을 만든다.
 * 로그인 ID·임시 비밀번호는 한 번만 보여 주고(`TempCredentialsDialog`), 연결 실패 원생은 이름과 함께 보여 준다.
 */
export function ParentCreateSheet({
  academyId,
  initialName,
  initialPhone,
  initialStudentIds,
  students,
  classes,
  escapeBlocked = false,
  onOpenStudentAction,
  onReloadAction,
  onCloseAction,
  onDoneAction,
}: {
  academyId: string;
  initialName: string;
  initialPhone: string;
  initialStudentIds: string[];
  students: readonly StudentVM[];
  classes: readonly AcademyClassBrief[];
  escapeBlocked?: boolean;
  onOpenStudentAction: (studentId: string) => void;
  onReloadAction: () => void;
  onCloseAction: () => void;
  onDoneAction: (message: string) => void;
}) {
  useBodyScrollLock(true);
  const [base] = useState(() => ({
    students: [...students],
    groupIds: new Set(initialStudentIds),
  }));
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState(initialPhone);
  const [selected, setSelected] = useState<string[]>(initialStudentIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResponse | null>(null);
  const [credentialsShown, setCredentialsShown] = useState(false);

  const nameOf = useMemo(() => {
    const m = new Map(base.students.map((s) => [s.id, s.name || "(이름 없음)"]));
    return (id: string) => m.get(id) ?? "삭제된 원생";
  }, [base.students]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 결과(임시 비밀번호)를 보여 주는 중에는 Esc로 닫지 않는다
      if (e.key === "Escape" && !busy && !escapeBlocked && !result) onCloseAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, escapeBlocked, result, onCloseAction]);

  const presets = useMemo<StudentMultiSelectPreset[]>(
    () => [
      { id: "group", label: "이 보호자 자녀", filter: (s) => base.groupIds.has(s.id), ignoreFilters: true },
      { id: "all", label: "전체", filter: () => true },
    ],
    [base.groupIds],
  );

  const validate = (): string | null => {
    const n = name.trim();
    if (!n || n.length > NAME_MAX) return `이름을 1~${NAME_MAX}자로 입력해 주세요.`;
    const phoneError = getKrPhoneValidationError(phone);
    if (phoneError) return phoneError;
    if (selected.length === 0) return "연결할 원생을 골라 주세요.";
    if (selected.length > MAX_LINK_STUDENTS) return `한 번에 ${MAX_LINK_STUDENTS}명까지 연결할 수 있습니다.`;
    return null;
  };

  const onSave = async () => {
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await httpsCallable(getFirebaseFunctions(), "createParentAccount")({
        academyId,
        displayName: name.trim(),
        phone,
        studentIds: selected,
      });
      setResult(res.data as CreateResponse);
      setCredentialsShown(true);
      onReloadAction();
    } catch (e) {
      setError(callableMessage(e, "계정을 만들지 못했습니다."));
    } finally {
      setBusy(false);
    }
  };

  const linkedSummary = (r: CreateResponse) => {
    const n = r.linked.length + r.alreadyLinked.length;
    return n > 0 ? `자녀 ${n}명과 연결했습니다.` : "연결된 자녀가 없습니다.";
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[160] flex flex-col bg-background"
        role="dialog"
        aria-modal="true"
        aria-labelledby="parent-create-title"
      >
        <header className="shrink-0 border-b border-neutral-200/80 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="mx-auto flex max-w-lg items-center justify-between gap-2">
            <h1 id="parent-create-title" className="min-w-0 truncate text-lg font-semibold text-foreground">
              학부모 계정 직접 만들기
            </h1>
            <button
              type="button"
              onClick={result ? () => onDoneAction(`${result.displayName || "학부모"} 계정을 만들었습니다.`) : onCloseAction}
              disabled={busy}
              className="shrink-0 text-sm text-neutral-500 hover:text-foreground disabled:opacity-40"
            >
              닫기
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-lg space-y-3 px-4 py-4">
            {result ? (
              <section className={sectionClass}>
                <p className="text-sm font-semibold text-foreground">
                  {result.displayName || "학부모"} 계정을 만들었습니다.
                </p>
                <p className="mt-1 text-xs text-neutral-600">{linkedSummary(result)}</p>
                {result.failures.length > 0 ? (
                  <div className="mt-2 rounded-2xl bg-red-500/10 px-3 py-2 text-xs text-red-900" role="alert">
                    <p className="break-keep">연결하지 못한 원생이 있습니다. 학부모 관리에서 다시 연결해 주세요.</p>
                    <ul className="mt-1 list-disc pl-4">
                      {result.failures.map((f) => (
                        <li key={f.studentId} className="break-keep">
                          {nameOf(f.studentId)} — {f.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            ) : (
              <>
                <p className="break-keep rounded-2xl bg-sky-500/10 px-3 py-2 text-[11px] text-sky-950">
                  학부모 대신 앱 계정을 만들어 줍니다. 로그인 ID와 임시 비밀번호를 전달하면, 학부모가 첫 로그인에서
                  비밀번호를 바꿉니다.
                </p>
                {error ? (
                  <p className="break-keep rounded-2xl bg-red-500/10 px-3 py-2 text-xs text-red-800" role="alert">
                    {error}
                  </p>
                ) : null}
                <section className={`${sectionClass} space-y-3`}>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-neutral-600">이름</span>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={NAME_MAX}
                      disabled={busy}
                      className={inputClass}
                      placeholder="보호자 이름"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-neutral-600">휴대폰 번호</span>
                    <KrPhoneInput value={phone} onChange={setPhone} disabled={busy} className={inputClass} />
                  </label>
                </section>
                <section className={sectionClass}>
                  <h2 className="mb-2 text-xs font-semibold text-foreground">연결할 자녀 {selected.length}명</h2>
                  <StudentMultiSelect
                    students={base.students}
                    selectedIds={selected}
                    onChangeAction={setSelected}
                    presets={presets}
                    defaultPresetId="group"
                    defaultStatus="enrolled"
                    classes={classes}
                    disabled={busy}
                    onOpenStudentAction={onOpenStudentAction}
                  />
                </section>
              </>
            )}
          </div>
        </main>

        <footer className="shrink-0 border-t border-neutral-200/80 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <div className="mx-auto max-w-lg">
            {result ? (
              <button
                type="button"
                onClick={() => onDoneAction(`${result.displayName || "학부모"} 계정을 만들었습니다.`)}
                className="w-full rounded-2xl bg-[#222] py-3 text-sm font-medium text-white"
              >
                완료
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void onSave()}
                className="w-full rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? "만드는 중…" : "계정 만들기"}
              </button>
            )}
          </div>
        </footer>
      </div>

      {result && credentialsShown ? (
        <TempCredentialsDialog
          title="학부모 계정을 만들었습니다"
          description={`로그인 ID와 임시 비밀번호를 학부모에게 전달해 주세요. ${linkedSummary(result)}`}
          rows={[{ displayName: result.displayName, loginId: result.loginId, tempPassword: result.tempPassword }]}
          onConfirmAction={() => {
            setCredentialsShown(false);
            if (result.failures.length === 0) onDoneAction(`${result.displayName || "학부모"} 계정을 만들었습니다.`);
          }}
        />
      ) : null}
    </ModalPortal>
  );
}
