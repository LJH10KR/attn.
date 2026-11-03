"use client";

import { httpsCallable } from "firebase/functions";
import { useEffect, useMemo, useState } from "react";
import { StudentMultiSelect, type StudentMultiSelectPreset } from "@/components/academy/student-multi-select";
import { STUDENT_STATUS_BADGE_CLASS } from "@/components/academy/student-detail/student-detail-sheet";
import {
  AppStateBadge,
  callableCode,
  callableMessage,
  ConfirmDialog,
  fmtDate,
  sectionClass,
} from "@/components/academy/parents/parent-ui";
import { ModalPortal } from "@/components/ui/modal-portal";
import {
  blocksSamePhoneLink,
  isAwaitingApproval,
  parentAppState,
  studentsMatchingPhone,
  type ParentAccountVM,
} from "@/lib/academy/parent-directory";
import { STUDENT_STATUS_LABELS } from "@/lib/academy/student-profile";
import type { StudentVM } from "@/lib/academy/student-row";
import type { AcademyClassBrief } from "@/lib/academy/use-academy-classes";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { formatKrPhoneDisplayOrDash } from "@/lib/phone/kr-phone";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

/** 서버 `MAX_LINK_STUDENTS`와 같음 */
export const MAX_LINK_STUDENTS = 20;

type LinkFailure = { studentId: string; message: string };
type LinkResponse = { linked: string[]; alreadyLinked: string[]; failures: LinkFailure[] };

export const SAME_PHONE_BLOCKED_MSG =
  "이미 다른 계정이 이 번호로 연결돼 있습니다. 기존 계정을 삭제해야 이 번호로 연결할 수 있습니다.";

/**
 * 승인·다시 연결·원생 더 연결 시트 — 저장은 `linkParentToStudents`(권한 `operations.parents`).
 * **시트를 연 순간 고정**(2-E memoBase·2-F 배정 시트 원칙): 원생 목록, 번호 일치 원생·기본 체크, 이미 연결된 원생,
 * 같은 번호의 다른 계정. 목록을 다시 읽어도 이 기준은 바뀌지 않는다(저장 결과로만 "연결됨"이 늘어남).
 */
export function ParentLinkSheet({
  academyId,
  account,
  students,
  accounts,
  classes,
  escapeBlocked = false,
  onOpenStudentAction,
  onOpenAccountAction,
  onReloadAction,
  onCloseAction,
  onDoneAction,
}: {
  academyId: string;
  account: ParentAccountVM;
  students: readonly StudentVM[];
  accounts: readonly ParentAccountVM[];
  classes: readonly AcademyClassBrief[];
  escapeBlocked?: boolean;
  onOpenStudentAction: (studentId: string) => void;
  /** 같은 번호 경고 줄에서 그 계정의 보호자 상세로 */
  onOpenAccountAction?: (uid: string) => void;
  onReloadAction: () => void;
  onCloseAction: () => void;
  onDoneAction: (message: string) => void;
}) {
  useBodyScrollLock(true);
  const [base] = useState(() => {
    const matched = studentsMatchingPhone(students, account.phoneKey);
    const linked = new Set(students.filter((s) => s.parentUids.includes(account.uid)).map((s) => s.id));
    const others = accounts.filter(
      (a) => a.uid !== account.uid && account.phoneKey.length > 0 && a.phoneKey === account.phoneKey,
    );
    return {
      account,
      students: [...students],
      matched,
      matchedIds: new Set(matched.map((s) => s.id)),
      linked,
      others,
      blocked: others.some(blocksSamePhoneLink),
    };
  });
  const [linkedNow, setLinkedNow] = useState<Set<string>>(base.linked);
  const [selected, setSelected] = useState<string[]>(() =>
    base.matched.filter((s) => !base.linked.has(s.id)).map((s) => s.id),
  );
  const [pickerOpen, setPickerOpen] = useState(() => base.matched.length === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<LinkResponse | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectBusy, setRejectBusy] = useState(false);
  const [rejectError, setRejectError] = useState<string | null>(null);

  const a = base.account;
  const awaiting = isAwaitingApproval(a);
  const state = parentAppState(a);
  const title = awaiting ? "가입 승인" : state === "unlinked" ? "다시 연결" : "원생 더 연결";
  const noPhone = !a.phone.trim();
  const nameOf = useMemo(() => {
    const m = new Map(base.students.map((s) => [s.id, s.name || "(이름 없음)"]));
    return (id: string) => m.get(id) ?? "삭제된 원생";
  }, [base.students]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || escapeBlocked || busy || rejectBusy) return;
      if (rejectOpen) setRejectOpen(false);
      else onCloseAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [escapeBlocked, busy, rejectBusy, rejectOpen, onCloseAction]);

  const presets = useMemo<StudentMultiSelectPreset[]>(
    () => [
      { id: "all", label: "전체", filter: () => true },
      { id: "matched", label: "번호 일치", filter: (s) => base.matchedIds.has(s.id), ignoreFilters: true },
    ],
    [base.matchedIds],
  );

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const tooMany = selected.length > MAX_LINK_STUDENTS;
  const canSave = !busy && !base.blocked && !noPhone && selected.length > 0 && !tooMany;

  const onSave = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const res = await httpsCallable(getFirebaseFunctions(), "linkParentToStudents")({
        academyId,
        parentUid: a.uid,
        studentIds: selected,
      });
      const data = res.data as LinkResponse;
      const failed = new Set(data.failures.map((f) => f.studentId));
      setLinkedNow((prev) => new Set([...prev, ...data.linked, ...data.alreadyLinked]));
      setSelected((prev) => prev.filter((id) => failed.has(id)));
      onReloadAction();
      if (data.failures.length === 0) {
        const parts = [
          data.linked.length > 0 ? `${data.linked.length}명 연결` : null,
          data.alreadyLinked.length > 0 ? `이미 연결됨 ${data.alreadyLinked.length}명` : null,
        ].filter(Boolean);
        onDoneAction(`${a.displayName || "학부모"}: ${parts.join(", ") || "바뀐 연결이 없습니다"}.`);
        return;
      }
      setOutcome(data);
    } catch (e) {
      const code = callableCode(e);
      onReloadAction();
      if (code === "not-found") {
        onDoneAction("다른 곳에서 이 계정이 삭제되었습니다.");
        return;
      }
      setError(callableMessage(e, "연결하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  };

  const onReject = async () => {
    setRejectBusy(true);
    setRejectError(null);
    try {
      await httpsCallable(getFirebaseFunctions(), "deleteParentAccount")({ academyId, parentUid: a.uid });
      onReloadAction();
      onDoneAction(`${a.displayName || "학부모"}님의 가입을 거절했습니다.`);
    } catch (e) {
      if (callableCode(e) === "not-found") {
        onReloadAction();
        onDoneAction("다른 곳에서 이 계정이 삭제되었습니다.");
        return;
      }
      setRejectError(callableMessage(e, "가입을 거절하지 못했습니다."));
      setRejectBusy(false);
    }
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[160] flex flex-col bg-background"
        role="dialog"
        aria-modal="true"
        aria-labelledby="parent-link-title"
      >
        <header className="shrink-0 border-b border-neutral-200/80 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="mx-auto flex max-w-lg items-center justify-between gap-2">
            <h1 id="parent-link-title" className="min-w-0 truncate text-lg font-semibold text-foreground">
              {title} · {a.displayName || "이름 없음"}
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
            <section className={sectionClass}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 truncate text-sm font-medium text-foreground">{a.displayName || "이름 없음"}</span>
                <AppStateBadge state={state} />
              </div>
              <dl className="mt-2 space-y-1 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-neutral-500">휴대폰</dt>
                  <dd className="text-foreground">{formatKrPhoneDisplayOrDash(a.phone)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-neutral-500">로그인 ID</dt>
                  <dd className="break-all text-right text-foreground">{a.loginId || "—"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-neutral-500">가입일</dt>
                  <dd className="text-foreground">{fmtDate(a.createdAtMs)}</dd>
                </div>
              </dl>
              <p className="mt-2 break-keep rounded-xl bg-sky-500/10 px-3 py-2 text-[11px] text-sky-950">
                휴대폰 번호가 일치하는지만 확인됐습니다. 보호자 본인인지는 학원에서 확인해 주세요.
              </p>
            </section>

            {noPhone ? (
              <p className="break-keep rounded-2xl bg-red-500/10 px-3 py-2 text-xs text-red-800" role="alert">
                계정에 휴대폰 번호가 없어 연결할 수 없습니다. 학부모가 앱 설정에서 번호를 입력한 뒤 연결해 주세요.
              </p>
            ) : null}

            {base.others.length > 0 ? (
              <section
                className={`space-y-1.5 rounded-2xl px-3 py-2 text-xs ${
                  base.blocked ? "bg-red-500/10 text-red-900" : "bg-amber-500/12 text-amber-950"
                }`}
                role={base.blocked ? "alert" : "status"}
              >
                <p className="break-keep font-semibold">
                  {base.blocked
                    ? SAME_PHONE_BLOCKED_MSG
                    : "같은 번호의 다른 계정이 있습니다. 형제를 각각 가입한 경우 한 계정에 모두 연결하고 나머지는 가입 거절해 주세요."}
                </p>
                <ul className="space-y-1">
                  {base.others.map((o) => (
                    <li key={o.uid} className="flex items-center gap-2">
                      <span className="min-w-0 truncate">{o.displayName || "이름 없음"}</span>
                      <span className="shrink-0 text-[10px] opacity-80">가입 {fmtDate(o.createdAtMs)}</span>
                      <AppStateBadge state={parentAppState(o)} />
                      {onOpenAccountAction ? (
                        <button
                          type="button"
                          className="ml-auto shrink-0 underline"
                          onClick={() => onOpenAccountAction(o.uid)}
                        >
                          보기
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {error ? (
              <p className="break-keep rounded-2xl bg-red-500/10 px-3 py-2 text-xs text-red-800" role="alert">
                {error}
              </p>
            ) : null}
            {outcome ? (
              <div className="space-y-1 rounded-2xl bg-red-500/10 px-3 py-2 text-xs text-red-900" role="alert">
                <p className="break-keep">
                  {outcome.linked.length > 0 ? `${outcome.linked.length}명은 연결했습니다.` : "연결된 원생이 없습니다."}
                  {outcome.alreadyLinked.length > 0 ? ` 이미 연결됨 ${outcome.alreadyLinked.length}명.` : ""}
                </p>
                <ul className="list-disc pl-4">
                  {outcome.failures.map((f) => (
                    <li key={f.studentId} className="break-keep">
                      {nameOf(f.studentId)} — {f.message}
                    </li>
                  ))}
                </ul>
                <p className="break-keep text-red-800/80">연결되지 않은 원생은 선택이 그대로 남아 있습니다.</p>
              </div>
            ) : null}

            <section className={sectionClass}>
              <h2 className="mb-1 text-xs font-semibold text-foreground">
                번호가 같은 원생 {base.matched.length > 0 ? `${base.matched.length}명` : ""}
              </h2>
              {base.matched.length === 0 ? (
                <p className="break-keep py-2 text-xs text-neutral-500">
                  보호자 번호가 이 계정 번호와 같은 원생이 없습니다. 아래에서 직접 골라 주세요.
                </p>
              ) : (
                <ul className="-mx-1 divide-y divide-neutral-200/70">
                  {base.matched.map((s) => {
                    const isLinked = linkedNow.has(s.id);
                    const checked = isLinked || selected.includes(s.id);
                    return (
                      <li key={s.id} className="flex items-center gap-2 py-1">
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={checked}
                          disabled={busy || isLinked || base.blocked}
                          onClick={() => toggle(s.id)}
                          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-1 py-1.5 text-left disabled:opacity-60"
                        >
                          <span
                            aria-hidden
                            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[11px] ${
                              checked ? "border-[#222] bg-[#222] text-white" : "border-neutral-400 bg-white"
                            }`}
                          >
                            {checked ? "✓" : ""}
                          </span>
                          <span className="min-w-0 truncate text-sm text-foreground">{s.name || "(이름 없음)"}</span>
                          {s.gradeLabel ? <span className="shrink-0 text-[11px] text-neutral-500">{s.gradeLabel}</span> : null}
                          {s.status !== "enrolled" ? (
                            <span
                              className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${STUDENT_STATUS_BADGE_CLASS[s.status]}`}
                            >
                              {STUDENT_STATUS_LABELS[s.status]}
                            </span>
                          ) : null}
                          {isLinked ? <span className="shrink-0 text-[10px] text-emerald-800">연결됨</span> : null}
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenStudentAction(s.id)}
                          className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-neutral-500 hover:bg-black/[0.04]"
                        >
                          정보
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className={sectionClass}>
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                aria-expanded={pickerOpen}
                className="flex w-full items-center justify-between text-xs font-semibold text-foreground"
              >
                다른 원생 직접 고르기
                <span aria-hidden className="text-neutral-400">
                  {pickerOpen ? "▲" : "▼"}
                </span>
              </button>
              {pickerOpen ? (
                <div className="mt-2">
                  <StudentMultiSelect
                    students={base.students}
                    selectedIds={selected}
                    onChangeAction={setSelected}
                    presets={presets}
                    defaultPresetId="all"
                    defaultStatus="enrolled"
                    classes={classes}
                    disabledIds={linkedNow}
                    disabledHint="이미 연결됨"
                    disabled={busy || base.blocked}
                    badge={(s) =>
                      base.matchedIds.has(s.id) ? (
                        <span className="shrink-0 rounded-full border border-sky-300/70 px-2 py-0.5 text-[10px] text-sky-900">
                          번호 일치
                        </span>
                      ) : null
                    }
                    onOpenStudentAction={onOpenStudentAction}
                  />
                </div>
              ) : null}
            </section>
          </div>
        </main>

        <footer className="shrink-0 border-t border-neutral-200/80 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <div className="mx-auto max-w-lg">
            <p className={`mb-2 text-center text-[11px] ${tooMany ? "text-red-700" : "text-neutral-500"}`}>
              {tooMany
                ? `한 번에 ${MAX_LINK_STUDENTS}명까지 연결할 수 있습니다(선택 ${selected.length}명).`
                : selected.length > 0
                  ? `연결할 원생 ${selected.length}명`
                  : "연결할 원생을 골라 주세요"}
            </p>
            <div className="flex gap-2">
              {awaiting ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setRejectError(null);
                    setRejectOpen(true);
                  }}
                  className="flex-1 rounded-2xl border border-red-300/80 py-3 text-sm font-medium text-red-700 disabled:opacity-50"
                >
                  가입 거절
                </button>
              ) : null}
              <button
                type="button"
                disabled={!canSave}
                onClick={() => void onSave()}
                className="flex-[2] rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? "연결 중…" : awaiting ? "승인하고 연결" : "연결"}
              </button>
            </div>
          </div>
        </footer>
      </div>

      {rejectOpen ? (
        <ConfirmDialog
          title={`${a.displayName || "이 학부모"}님의 가입을 거절할까요?`}
          body="앱 계정과 로그인 정보가 삭제됩니다. 원생 정보와 보호자 연락처는 그대로 남습니다."
          confirmLabel="가입 거절"
          danger
          busy={rejectBusy}
          error={rejectError}
          onCancelAction={() => setRejectOpen(false)}
          onConfirmAction={() => void onReject()}
        />
      ) : null}
    </ModalPortal>
  );
}
