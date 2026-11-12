"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { ModalPortal } from "@/components/ui/modal-portal";
import {
  BULK_MSG,
  BULK_STUDENT_COLUMN_LABELS,
  BULK_STUDENT_COLUMNS,
  bulkDuplicateKey,
  bulkInTableDuplicates,
  emptyBulkStudentDraft,
  isBlankBulkStudentDraft,
  MAX_BULK_STUDENTS,
  parseGradeText,
  pastedTextToDrafts,
  resolveBulkStudentDraft,
  type BulkFieldError,
  type BulkStudentColumn,
  type BulkStudentDraft,
  type BulkStudentInput,
} from "@/lib/academy/student-bulk";
import type { DisplayGrade } from "@/lib/academy/student-profile";
import type { AcademyClassBrief } from "@/lib/academy/use-academy-classes";
import type { AcademyOptionItem } from "@/lib/firebase/attn-schema";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

/**
 * 원생 여러 명 입력 표(2-M, L4-1·L4-1-2·M3) — 붙여 넣기(엑셀·구글 시트) + 줄 추가 직접 입력, 새 원생만 추가(★2).
 * 줄 검사는 서버(`createStudentsBulk`)와 같은 판단(`student-bulk.ts`). 오류 줄·확인 안 한 경고 줄은 보내지 않고 표에 남는다.
 * 저장하면 성공 줄은 사라지고 실패 줄만 서버 문구와 함께 남는다. 표는 시트 안에서만 가로로 스크롤(페이지는 밀리지 않음).
 */

type Row = {
  key: string;
  draft: BulkStudentDraft;
  allowDuplicate: boolean;
  /** 서버가 돌려준 실패 문구(줄을 고치면 지움) */
  serverError: string | null;
  /** 서버가 동명이인으로 돌려보냄 — 확인 체크가 필요 */
  serverDuplicate: boolean;
};

type BulkResult =
  | { rowKey: string; ok: true; studentId: string; attnId: string; classAssigned: boolean; classError?: string }
  | { rowKey: string; ok: false; code: string; message: string };

const INITIAL_ROWS = 3;
let rowSeq = 0;
const newRow = (draft: BulkStudentDraft = emptyBulkStudentDraft()): Row => {
  rowSeq += 1;
  return { key: `r${Date.now().toString(36)}${rowSeq}`, draft, allowDuplicate: false, serverError: null, serverDuplicate: false };
};

const cellInput =
  "w-full min-w-0 rounded-lg border bg-white/70 px-2 py-2 text-base text-foreground outline-none focus:border-[#4a90e2] dark:bg-white/[0.06] sm:text-sm";
const COL_WIDTH: Record<BulkStudentColumn, string> = {
  name: "w-[124px] min-w-[124px]",
  grade: "w-[76px] min-w-[76px]",
  school: "w-[112px] min-w-[112px]",
  g1Relation: "w-[100px] min-w-[100px]",
  g1Phone: "w-[148px] min-w-[148px]",
  g2Relation: "w-[100px] min-w-[100px]",
  g2Phone: "w-[148px] min-w-[148px]",
  className: "w-[128px] min-w-[128px]",
};
const PLACEHOLDER: Partial<Record<BulkStudentColumn, string>> = {
  name: "이름",
  grade: "초3",
  school: "학교",
  g1Phone: "010-0000-0000",
  g2Phone: "010-0000-0000",
};

type ExistingStudent = { name: string; displayGrade: DisplayGrade | null };

export function StudentBulkSheet({
  academyId,
  relations,
  classes,
  canAssignClass,
  existingStudents,
  onCloseAction,
  onSavedAction,
}: {
  academyId: string;
  relations: AcademyOptionItem[];
  classes: AcademyClassBrief[];
  canAssignClass: boolean;
  existingStudents: ExistingStudent[];
  onCloseAction: () => void;
  /** 한 명이라도 저장되면 — 목록 다시 읽기. `closed`면 모두 저장되어 시트를 닫음 */
  onSavedAction: (message: string, closed: boolean) => void;
}) {
  useBodyScrollLock(true);
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: INITIAL_ROWS }, () => newRow()));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState("");
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onCloseAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCloseAction, saving]);

  const columns = useMemo(
    () => BULK_STUDENT_COLUMNS.filter((c) => c !== "className" || canAssignClass),
    [canAssignClass],
  );
  const relationOptions = useMemo(() => relations.map((r) => ({ id: r.id, label: r.label })), [relations]);
  const classOptions = useMemo(() => classes.map((c) => ({ id: c.id, name: c.name, status: c.status })), [classes]);
  const pickableClasses = useMemo(() => classes.filter((c) => c.status !== "ended"), [classes]);
  const existingKeys = useMemo(
    () => new Set(existingStudents.map((s) => bulkDuplicateKey(s.name, s.displayGrade))),
    [existingStudents],
  );

  /** 줄마다 검사 결과 — 서버와 같은 판단 */
  const checked = useMemo(() => {
    const resolved = rows.map((r) => {
      if (isBlankBulkStudentDraft(r.draft)) return null;
      return resolveBulkStudentDraft(r.draft, {
        rowKey: r.key,
        relations: relationOptions,
        classes: classOptions,
        canAssignClass,
        allowDuplicate: r.allowDuplicate,
      });
    });
    const keys = rows.map((r, i) => {
      if (!resolved[i]) return null;
      const grade = parseGradeText(r.draft.grade);
      return r.draft.name.trim() && grade ? bulkDuplicateKey(r.draft.name, grade) : null;
    });
    const inTable = bulkInTableDuplicates(keys);
    return rows.map((r, i) => {
      const res = resolved[i];
      if (!res) return { blank: true as const };
      const warning =
        keys[i] && existingKeys.has(keys[i]!)
          ? BULK_MSG.duplicateExisting
          : inTable.has(i)
            ? BULK_MSG.duplicateInTable
            : r.serverDuplicate
              ? BULK_MSG.duplicateExisting
              : null;
      const ready = res.errors.length === 0 && (!warning || r.allowDuplicate);
      return { blank: false as const, errors: res.errors, input: res.input, warning, ready };
    });
  }, [rows, relationOptions, classOptions, canAssignClass, existingKeys]);

  const readyInputs = checked.flatMap((c) => (!c.blank && c.ready && c.input ? [c.input] : []));
  const errorCount = checked.filter((c) => !c.blank && c.errors.length > 0).length;
  const confirmCount = checked.filter((c) => !c.blank && c.errors.length === 0 && c.warning && !c.ready).length;

  const updateRow = (key: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const updateCell = (key: string, col: BulkStudentColumn, value: string) =>
    setRows((prev) =>
      prev.map((r) =>
        r.key === key ? { ...r, draft: { ...r.draft, [col]: value }, serverError: null, serverDuplicate: col === "name" || col === "grade" ? false : r.serverDuplicate } : r,
      ),
    );

  /** 붙여 넣기 — `rowIndex` 줄의 `column` 칸부터(머리글이 있으면 새 줄로 이름 맞춤). 빈 칸은 기존 값을 지우지 않음 */
  const applyPaste = (text: string, rowIndex: number | null, column: number) => {
    if (saving) return;
    // 위 붙여 넣기 칸: 마지막으로 채운 줄 다음부터(그 뒤 빈 줄을 쓰고, 모자라면 새 줄) — 이미 채운 줄을 덮지 않게.
    // 표 안 칸: 그 칸부터 펼침
    const lastFilled = rows.reduce((acc, r, i) => (isBlankBulkStudentDraft(r.draft) ? acc : i), -1);
    const startRow = rowIndex ?? lastFilled + 1;
    const capacity = MAX_BULK_STUDENTS - startRow;
    const res = pastedTextToDrafts(text, { startColumn: BULK_STUDENT_COLUMNS.indexOf(columns[column] ?? "name"), limit: Math.max(0, capacity) });
    if (res.drafts.length === 0) {
      if (res.droppedCount > 0) setNotice(`표는 ${MAX_BULK_STUDENTS}줄까지예요. 저장한 뒤 다시 붙여 넣어 주세요.`);
      return;
    }
    let clearedClass = false;
    const drafts = res.drafts.map((d) => {
      if (!canAssignClass && d.className) {
        clearedClass = true;
        return { ...d, className: "" };
      }
      return d;
    });
    setRows((prev) => {
      const next = [...prev];
      const begin = res.headerDetected && rowIndex !== null ? next.length : startRow;
      drafts.forEach((d, i) => {
        const at = begin + i;
        if (at >= MAX_BULK_STUDENTS) return;
        const base = next[at];
        if (!base) {
          next[at] = newRow(d);
          return;
        }
        const merged = { ...base.draft };
        for (const col of BULK_STUDENT_COLUMNS) if (d[col] !== "") merged[col] = d[col];
        next[at] = { ...base, draft: merged, serverError: null, serverDuplicate: false };
      });
      return next.slice(0, MAX_BULK_STUDENTS);
    });
    const parts = [`${drafts.length}줄을 넣었어요.`];
    if (res.headerDetected) parts.push("첫 줄은 머리글로 보고 칸을 맞췄어요.");
    if (res.ignoredHeaders.length > 0) parts.push(`무시한 칸: ${res.ignoredHeaders.join(", ")}`);
    if (res.droppedCount > 0) parts.push(`나머지 ${res.droppedCount}줄은 저장한 뒤 다시 붙여 넣어 주세요.`);
    if (clearedClass) parts.push("반 칸은 반 관리 권한이 있을 때만 넣을 수 있어 비웠어요.");
    setNotice(parts.join(" "));
  };

  const onCellPaste = (e: ClipboardEvent<HTMLInputElement>, rowIndex: number, column: number) => {
    const text = e.clipboardData.getData("text/plain");
    if (!/[\t\n\r]/.test(text.trim())) return;
    e.preventDefault();
    applyPaste(text, rowIndex, column);
  };

  const addRow = () => setRows((prev) => (prev.length >= MAX_BULK_STUDENTS ? prev : [...prev, newRow()]));
  const removeRow = (key: string) =>
    setRows((prev) => {
      const next = prev.filter((r) => r.key !== key);
      return next.length > 0 ? next : [newRow()];
    });

  const save = async () => {
    if (readyInputs.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const fn = httpsCallable<{ academyId: string; rows: BulkStudentInput[] }, { results: BulkResult[]; createdCount: number }>(
        getFirebaseFunctions(),
        "createStudentsBulk",
        { timeout: 180_000 },
      );
      const res = await fn({ academyId, rows: readyInputs });
      const byKey = new Map(res.data.results.map((r) => [r.rowKey, r]));
      const classErrors: string[] = [];
      let classAssigned = 0;
      for (const r of res.data.results) {
        if (!r.ok) continue;
        if (r.classAssigned) classAssigned += 1;
        if (r.classError) {
          const row = rows.find((x) => x.key === r.rowKey);
          classErrors.push(`${row?.draft.name.trim() ?? ""}(${row?.draft.className.trim() ?? ""}): ${r.classError}`);
        }
      }
      const remaining = rows
        .filter((r) => !(byKey.get(r.key)?.ok === true))
        .map((r) => {
          const out = byKey.get(r.key);
          if (!out || out.ok) return r;
          return {
            ...r,
            serverError: out.code === "duplicate" ? null : out.message,
            serverDuplicate: out.code === "duplicate",
            allowDuplicate: out.code === "duplicate" ? false : r.allowDuplicate,
          };
        });
      const created = res.data.createdCount;
      const failed = res.data.results.length - created;
      const parts: string[] = [];
      if (created > 0) parts.push(`${created}명 저장했어요${classAssigned > 0 ? `(반 배정 ${classAssigned}명)` : ""}.`);
      if (failed > 0) parts.push(`실패 ${failed}줄은 고쳐서 다시 저장해 주세요.`);
      if (classErrors.length > 0) {
        parts.push(`원생은 저장했지만 반 배정을 못 했어요: ${classErrors.join(", ")} — 반 관리에서 배정해 주세요.`);
      }
      const leftover = remaining.filter((r) => !isBlankBulkStudentDraft(r.draft));
      if (created > 0) {
        const closed = leftover.length === 0 && classErrors.length === 0;
        onSavedAction(closed ? `${created}명을 저장했어요.` : parts.join(" "), closed);
        if (closed) return;
      }
      setRows(leftover.length > 0 ? remaining : [newRow()]);
      setNotice(parts.join(" ") || null);
    } catch (e) {
      setError(e instanceof FirebaseError && e.message ? e.message : "저장하지 못했어요. 다시 시도해 주세요.");
    } finally {
      setSaving(false);
    }
  };

  const fieldErrorOf = (errors: BulkFieldError[], col: BulkStudentColumn) => errors.find((e) => e.field === col);

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[205] flex flex-col bg-background"
        role="dialog"
        aria-modal="true"
        aria-labelledby="student-bulk-title"
        data-student-bulk-sheet
      >
        <header className="shrink-0 border-b border-neutral-200/80 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="mx-auto flex max-w-5xl items-center justify-between">
            <h1 id="student-bulk-title" className="text-lg font-semibold text-foreground">
              원생 여러 명 입력
            </h1>
            <button
              type="button"
              onClick={onCloseAction}
              disabled={saving}
              className="text-sm text-neutral-500 disabled:opacity-40"
            >
              닫기
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-4 py-4">
            {/* 저장하는 동안 표 전체 잠금 — 저장 응답은 누를 때의 줄로 남은 줄을 다시 만들기 때문(그 사이 고친 값이 사라지지 않게) */}
            <fieldset disabled={saving} aria-busy={saving} className="m-0 min-w-0 space-y-3 border-0 p-0" data-student-bulk-fieldset>
            <p className="break-keep text-sm text-neutral-600">
              엑셀·구글 시트에서 칸을 복사해 붙여 넣거나, 줄을 추가해 직접 입력하세요. 한 번에 {MAX_BULK_STUDENTS}명까지
              저장할 수 있어요.
            </p>
            <p className="break-keep text-[11px] text-neutral-500">
              칸 순서: {columns.map((c) => BULK_STUDENT_COLUMN_LABELS[c]).join(" · ")} (첫 줄이 머리글이면 이름으로 맞춰요).
              모두 재원으로 저장돼요.
            </p>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              onPaste={(e) => {
                const text = e.clipboardData.getData("text/plain");
                if (!text.trim()) return;
                e.preventDefault();
                applyPaste(text, null, 0);
                setPasteText("");
              }}
              rows={2}
              placeholder="여기에 붙여 넣기"
              aria-label="여기에 붙여 넣기"
              className="w-full rounded-2xl border border-dashed border-neutral-300 bg-white/60 px-3 py-2.5 text-base outline-none focus:border-[#4a90e2] dark:bg-white/[0.06] sm:text-sm"
              data-student-bulk-paste
            />
            {pasteText.trim() ? (
              <button
                type="button"
                onClick={() => {
                  applyPaste(pasteText, null, 0);
                  setPasteText("");
                }}
                className="rounded-[8px] border border-neutral-300/70 bg-white/70 px-3 py-2 text-xs font-medium"
              >
                표에 넣기
              </button>
            ) : null}
            {notice ? (
              <p className="break-keep rounded-xl bg-sky-500/10 px-3 py-2 text-xs text-sky-950 dark:text-sky-200" role="status">
                {notice}
              </p>
            ) : null}
            {error ? (
              <p className="break-keep rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-800" role="alert">
                {error}
              </p>
            ) : null}

            <div ref={tableRef} className="overflow-x-auto rounded-2xl ring-1 ring-neutral-200 dark:ring-white/10" data-student-bulk-table>
              <table className="border-separate border-spacing-0 text-left">
                <thead>
                  <tr className="text-[11px] text-neutral-500">
                    {columns.map((c, ci) => (
                      <th
                        key={c}
                        scope="col"
                        className={`${COL_WIDTH[c]} border-b border-neutral-200 bg-neutral-50 px-1.5 py-2 font-medium dark:border-white/10 dark:bg-neutral-900 ${
                          ci === 0 ? "sticky left-0 z-10" : ""
                        }`}
                      >
                        {BULK_STUDENT_COLUMN_LABELS[c]}
                        {c === "name" || c === "grade" ? <span className="text-red-600">*</span> : null}
                      </th>
                    ))}
                    <th className="w-10 min-w-10 border-b border-neutral-200 bg-neutral-50 dark:border-white/10 dark:bg-neutral-900" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, ri) => {
                    const c = checked[ri]!;
                    const errors = c.blank ? [] : c.errors;
                    const messages = [
                      ...errors.map((e) => e.message),
                      ...(r.serverError ? [r.serverError] : []),
                    ];
                    const hasProblem = !c.blank && (errors.length > 0 || r.serverError);
                    return [
                      <tr key={r.key} data-student-bulk-row={ri} data-row-state={c.blank ? "blank" : hasProblem ? "error" : c.warning && !c.ready ? "confirm" : "ready"}>
                        {columns.map((col, ci) => {
                          const fe = fieldErrorOf(errors, col);
                          const border = fe ? "border-red-400" : "border-neutral-300/70 dark:border-white/15";
                          const value = r.draft[col];
                          const stickyCls = ci === 0 ? "sticky left-0 z-10 bg-background" : "";
                          if (col === "g1Relation" || col === "g2Relation" || col === "className") {
                            const opts =
                              col === "className"
                                ? pickableClasses.map((x) => ({ value: x.name, label: x.name }))
                                : relations.map((x) => ({ value: x.label, label: x.label }));
                            const unknown = value.trim() && !opts.some((o) => o.value === value.trim());
                            return (
                              <td key={col} className={`${COL_WIDTH[col]} px-1 py-1 align-top ${stickyCls}`}>
                                <select
                                  value={unknown ? `__raw__${value}` : value.trim()}
                                  onChange={(e) => updateCell(r.key, col, e.target.value.startsWith("__raw__") ? value : e.target.value)}
                                  aria-label={`${ri + 1}번 줄 ${BULK_STUDENT_COLUMN_LABELS[col]}`}
                                  className={`${cellInput} ${border} pr-1`}
                                >
                                  <option value="">{col === "className" ? "반 없음" : "관계 없음"}</option>
                                  {opts.map((o) => (
                                    <option key={o.value} value={o.value}>
                                      {o.label}
                                    </option>
                                  ))}
                                  {unknown ? <option value={`__raw__${value}`}>‘{value}’ 없음</option> : null}
                                </select>
                              </td>
                            );
                          }
                          return (
                            <td key={col} className={`${COL_WIDTH[col]} px-1 py-1 align-top ${stickyCls}`}>
                              <div className="flex items-center gap-1">
                                {ci === 0 ? <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-neutral-400">{ri + 1}</span> : null}
                                <input
                                  value={value}
                                  onChange={(e) => updateCell(r.key, col, e.target.value)}
                                  onPaste={(e) => onCellPaste(e, ri, ci)}
                                  placeholder={PLACEHOLDER[col]}
                                  inputMode={col === "g1Phone" || col === "g2Phone" ? "tel" : undefined}
                                  aria-label={`${ri + 1}번 줄 ${BULK_STUDENT_COLUMN_LABELS[col]}`}
                                  className={`${cellInput} ${border} ${col === "g1Phone" || col === "g2Phone" ? "font-mono" : ""}`}
                                />
                              </div>
                            </td>
                          );
                        })}
                        <td className="w-10 min-w-10 px-1 py-1 align-top">
                          <button
                            type="button"
                            onClick={() => removeRow(r.key)}
                            aria-label={`${ri + 1}번 줄 삭제`}
                            className="h-9 w-8 rounded-lg text-neutral-400 hover:bg-black/[0.04]"
                          >
                            ✕
                          </button>
                        </td>
                      </tr>,
                      messages.length > 0 || (!c.blank && c.warning) ? (
                        <tr key={`${r.key}-msg`}>
                          <td colSpan={columns.length + 1} className="px-2 pb-2">
                            <div className="sticky left-2 w-[calc(100vw-4rem)] max-w-[560px] space-y-1">
                              {messages.map((m, mi) => (
                                <p key={mi} className="break-keep text-[11px] text-red-700 dark:text-red-300" data-student-bulk-error>
                                  {m}
                                </p>
                              ))}
                              {!c.blank && c.warning && errors.length === 0 ? (
                                <label className="flex items-start gap-2 text-[11px] text-amber-800 dark:text-amber-300" data-student-bulk-warning>
                                  <input
                                    type="checkbox"
                                    checked={r.allowDuplicate}
                                    onChange={(e) => updateRow(r.key, { allowDuplicate: e.target.checked })}
                                    className="mt-0.5"
                                  />
                                  <span className="break-keep">{c.warning} 동명이인이에요, 그대로 저장</span>
                                </label>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ) : null,
                    ];
                  })}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              onClick={addRow}
              disabled={rows.length >= MAX_BULK_STUDENTS}
              className="rounded-[8px] border border-neutral-300/70 bg-white/70 px-3 py-2 text-xs font-medium disabled:opacity-40"
            >
              + 줄 추가
            </button>
            </fieldset>
          </div>
        </main>

        <footer className="shrink-0 border-t border-neutral-200/80 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
            <p className="min-w-0 break-keep text-xs text-neutral-600" data-student-bulk-summary>
              저장할 줄 {readyInputs.length} · 오류 {errorCount} · 확인 필요 {confirmCount}
            </p>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || readyInputs.length === 0}
              className="shrink-0 rounded-2xl bg-[#222] px-5 py-3 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-950"
            >
              {saving ? "저장 중…" : `저장(${readyInputs.length}명)`}
            </button>
          </div>
        </footer>
      </div>
    </ModalPortal>
  );
}
