"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useEffect, useMemo, useState } from "react";
import { StudentMultiSelect, type StudentMultiSelectPreset } from "@/components/academy/student-multi-select";
import { ModalPortal } from "@/components/ui/modal-portal";
import type { StudentVM } from "@/lib/academy/student-row";
import type { AcademyClassBrief } from "@/lib/academy/use-academy-classes";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

/** 서버 `setClassStudents` 한 번에 바꿀 수 있는 원생 수 */
const MAX_PER_CALL = 100;

type AssignResponse = {
  added: string[];
  removed: string[];
  failures: { studentId: string; message: string }[];
  studentCount: number;
  capacity: number | null;
  overCapacity: boolean;
};

type Outcome = {
  added: number;
  removed: number;
  failures: { studentId: string; message: string }[];
  /** 중간 호출이 통째로 실패한 경우 그 문구 */
  callError: string | null;
  studentCount: number | null;
  capacity: number | null;
  overCapacity: boolean;
};

function errMsg(err: unknown, fallback: string): string {
  return err instanceof FirebaseError && err.message ? err.message : fallback;
}

type ClassAssignSheetProps = {
  academyId: string;
  /** 시트를 연 순간의 반 — 종강 여부·정원도 이 값으로 판단 */
  cls: AcademyClassBrief;
  /** 원생 목록(읽기가 성공한 뒤에만 이 시트를 연다) — 다시 읽어도 기준·선택값은 바뀌지 않는다 */
  students: StudentVM[];
  classNameOf: (id: string) => string | null;
  onOpenStudentAction: (studentId: string) => void;
  escapeBlocked?: boolean;
  onReloadStudentsAction: () => void;
  onCloseAction: () => void;
  onDoneAction: (message: string) => void;
};

/**
 * 원생 배정 시트 — 시트를 연 순간의 "반 원생" 집합을 기준으로 고정하고, 저장 때 그 기준과 선택값의 차이로만
 * add/remove를 만든다(시트를 연 사이 다른 곳에서 추가한 원생을 해제하지 않게). 100명씩 나눠 보내며,
 * 중간에 실패하면 반영된 만큼 기준을 옮기고 결과를 보여 준다(남은 차이는 다시 저장할 수 있음).
 */
export function ClassAssignSheet({
  academyId,
  cls,
  students,
  classNameOf,
  onOpenStudentAction,
  escapeBlocked = false,
  onReloadStudentsAction,
  onCloseAction,
  onDoneAction,
}: ClassAssignSheetProps) {
  useBodyScrollLock(true);
  const [snapshot] = useState(() => ({
    id: cls.id,
    name: cls.name,
    ended: cls.status === "ended",
    capacity: cls.capacity,
  }));
  const [base, setBase] = useState<ReadonlySet<string>>(
    () => new Set(students.filter((s) => s.classIds.includes(cls.id)).map((s) => s.id)),
  );
  const [initialBase] = useState(base);
  const [selected, setSelected] = useState<string[]>(() => [...base]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !escapeBlocked) onCloseAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, escapeBlocked, onCloseAction]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const add = selected.filter((id) => !base.has(id));
  const remove = [...base].filter((id) => !selectedSet.has(id));
  const nameOf = (id: string) => students.find((s) => s.id === id)?.name || "(알 수 없는 원생)";

  const presets = useMemo<StudentMultiSelectPreset[]>(
    () => [
      // 상태·학년 필터와 관계없이 지금(연 순간) 배정된 원생 모두 — 퇴원 원생도 빼려면 보여야 함
      { id: "assigned", label: "배정됨", filter: (s) => initialBase.has(s.id), ignoreFilters: true },
      { id: "unassigned", label: "미배정", filter: (s) => !initialBase.has(s.id) },
      { id: "all", label: "전체", filter: () => true },
    ],
    [initialBase],
  );

  // 종강 반 — 반에 없던 원생은 고를 수 없음(해제만)
  const disabledIds = useMemo(
    () => (snapshot.ended ? new Set(students.filter((s) => !base.has(s.id)).map((s) => s.id)) : undefined),
    [snapshot.ended, students, base],
  );

  const overCapacity = snapshot.capacity !== null && selected.length > snapshot.capacity;

  const onSave = async () => {
    if (add.length + remove.length === 0) {
      onCloseAction();
      return;
    }
    setBusy(true);
    setOutcome(null);
    const ops: { id: string; kind: "add" | "remove" }[] = [
      ...add.map((id) => ({ id, kind: "add" as const })),
      ...remove.map((id) => ({ id, kind: "remove" as const })),
    ];
    const result: Outcome = {
      added: 0,
      removed: 0,
      failures: [],
      callError: null,
      studentCount: null,
      capacity: snapshot.capacity,
      overCapacity: false,
    };
    const nextBase = new Set(base);
    const fn = httpsCallable(getFirebaseFunctions(), "setClassStudents");
    try {
      for (let i = 0; i < ops.length; i += MAX_PER_CALL) {
        const chunk = ops.slice(i, i + MAX_PER_CALL);
        const res = await fn({
          academyId,
          classId: snapshot.id,
          add: chunk.filter((o) => o.kind === "add").map((o) => o.id),
          remove: chunk.filter((o) => o.kind === "remove").map((o) => o.id),
        });
        const data = res.data as AssignResponse;
        result.added += data.added.length;
        result.removed += data.removed.length;
        result.failures.push(...data.failures);
        result.studentCount = data.studentCount;
        result.capacity = data.capacity;
        result.overCapacity = data.overCapacity;
        // 반영된 만큼(이미 그 상태였던 원생 포함) 기준을 옮긴다 — 실패한 원생만 차이로 남음
        const failed = new Set(data.failures.map((f) => f.studentId));
        for (const o of chunk) {
          if (failed.has(o.id)) continue;
          if (o.kind === "add") nextBase.add(o.id);
          else nextBase.delete(o.id);
        }
      }
    } catch (e) {
      result.callError = errMsg(e, "원생 배정을 저장하지 못했습니다.");
    }
    setBase(nextBase);
    setBusy(false);
    onReloadStudentsAction();

    const summary = [
      result.added > 0 ? `${result.added}명 추가` : null,
      result.removed > 0 ? `${result.removed}명 해제` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const capacityNote =
      result.overCapacity && result.capacity !== null && result.studentCount !== null
        ? ` 정원 ${result.capacity}명을 넘었습니다(지금 ${result.studentCount}명).`
        : "";
    if (!result.callError && result.failures.length === 0) {
      onDoneAction(`${snapshot.name}: ${summary || "바뀐 원생이 없습니다"}.${capacityNote}`);
      return;
    }
    setOutcome(result);
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[160] flex flex-col bg-background"
        role="dialog"
        aria-modal="true"
        aria-labelledby="class-assign-title"
      >
        <header className="shrink-0 border-b border-neutral-200/80 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="mx-auto flex max-w-lg items-center justify-between gap-2">
            <h1 id="class-assign-title" className="min-w-0 truncate text-lg font-semibold text-foreground">
              원생 배정 · {snapshot.name}
            </h1>
            <button
              type="button"
              onClick={onCloseAction}
              disabled={busy}
              className="shrink-0 text-sm text-neutral-500 hover:text-foreground disabled:opacity-40"
            >
              닫기
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-lg space-y-3 px-4 py-4">
            {snapshot.ended ? (
              <p className="break-keep rounded-2xl bg-neutral-500/10 px-3 py-2 text-xs text-neutral-700">
                종강한 반입니다. 원생을 해제만 할 수 있고, 추가하려면 반을 다시 열어 주세요.
              </p>
            ) : null}
            {overCapacity ? (
              <p className="break-keep rounded-2xl bg-amber-500/12 px-3 py-2 text-xs text-amber-950" role="status">
                정원 {snapshot.capacity}명을 넘습니다(선택 {selected.length}명). 저장은 됩니다.
              </p>
            ) : null}
            {outcome ? (
              <div className="space-y-1 rounded-2xl bg-red-500/10 px-3 py-2 text-xs text-red-900" role="alert">
                <p className="break-keep">
                  {outcome.added + outcome.removed > 0
                    ? `${outcome.added}명 추가, ${outcome.removed}명 해제까지 반영했습니다.`
                    : "반영된 원생이 없습니다."}
                  {outcome.overCapacity && outcome.capacity !== null && outcome.studentCount !== null
                    ? ` 정원 ${outcome.capacity}명을 넘었습니다(지금 ${outcome.studentCount}명).`
                    : ""}
                </p>
                {outcome.callError ? <p className="break-keep">저장이 중간에 멈췄습니다: {outcome.callError}</p> : null}
                {outcome.failures.length > 0 ? (
                  <ul className="list-disc pl-4">
                    {outcome.failures.map((f) => (
                      <li key={f.studentId} className="break-keep">
                        {nameOf(f.studentId)} — {f.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="break-keep text-red-800/80">반영되지 않은 원생은 선택이 그대로 남아 있어 다시 저장할 수 있습니다.</p>
              </div>
            ) : null}

            <StudentMultiSelect
              students={students}
              selectedIds={selected}
              onChangeAction={setSelected}
              presets={presets}
              defaultPresetId="assigned"
              defaultStatus="enrolled"
              disabledIds={disabledIds}
              disabledHint="종강한 반에는 추가할 수 없습니다"
              disabled={busy}
              badge={(s) => {
                const others = s.classIds.filter((id) => id !== snapshot.id).flatMap((id) => classNameOf(id) ?? []);
                return others.length > 0 ? (
                  <span
                    className="max-w-[7rem] truncate rounded-full border border-neutral-300/70 px-2 py-0.5 text-[10px] text-neutral-600"
                    title={others.join(", ")}
                  >
                    {others.length === 1 ? others[0] : `다른 반 ${others.length}`}
                  </span>
                ) : null;
              }}
              onOpenStudentAction={onOpenStudentAction}
            />
          </div>
        </main>

        <footer className="shrink-0 border-t border-neutral-200/80 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <div className="mx-auto max-w-lg">
            <p className="mb-2 text-center text-[11px] text-neutral-500">
              {add.length + remove.length === 0 ? "바뀐 원생이 없습니다" : `추가 ${add.length}명 · 해제 ${remove.length}명`}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void onSave()}
              className="w-full rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "저장 중…" : "저장"}
            </button>
          </div>
        </footer>
      </div>
    </ModalPortal>
  );
}
