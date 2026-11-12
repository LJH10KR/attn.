"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useEffect, useMemo, useState } from "react";
import { ModalPortal } from "@/components/ui/modal-portal";
import { withinViewerPermissions, type PermissionViewer } from "@/lib/academy/role-policy";
import {
  BULK_STAFF_MSG,
  bulkStaffDuplicatePhones,
  MAX_BULK_STAFF,
  staffConflictMessage,
  staffPhoneConflict,
  validateBulkStaffInput,
  type BulkStaffInput,
  type ExistingStaffPhoneRow,
} from "@/lib/academy/staff-bulk";
import type { AcademyRoleVM } from "@/lib/academy/use-academy-roles";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { formatKrPhoneInput } from "@/lib/phone/kr-phone";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

/**
 * 직원 여러 명 미리 등록 표(2-M, L4-2-2) — 이름*·번호*·가입하면 줄 권한. 저장하면 계정 없는 직원(미리 등록).
 * 그 번호로 직원 가입 QR에서 가입하고 문자로 번호를 확인하면, 후보 1명 + 권한이면 바로 활성(2-L).
 * 줄 검사는 서버(`createStaffPreRegistrations`)와 같은 판단(`staff-bulk.ts`). 권한 칸은 멤버 관리 권한이 있을 때만,
 * 내가 줄 수 있는 역할만 고른다(서버도 같은 검사).
 */

type Row = {
  key: string;
  displayName: string;
  phone: string;
  signupRoleId: string;
  allowDuplicatePhone: boolean;
  serverError: string | null;
  serverConflict: "pre_registered" | "account" | null;
};

type Result =
  | { rowKey: string; ok: true; staffId: string; signupRoleId: string | null }
  | { rowKey: string; ok: false; code: string; message: string; conflict?: "pre_registered" | "account" };

let seq = 0;
const newRow = (): Row => {
  seq += 1;
  return {
    key: `s${Date.now().toString(36)}${seq}`,
    displayName: "",
    phone: "",
    signupRoleId: "",
    allowDuplicatePhone: false,
    serverError: null,
    serverConflict: null,
  };
};
const isBlank = (r: Row) => !r.displayName.trim() && !r.phone.trim() && !r.signupRoleId;

const fieldClass =
  "w-full min-w-0 rounded-xl border bg-white/70 px-3 py-2.5 text-base text-foreground outline-none focus:border-[#4a90e2] dark:bg-white/[0.06] sm:text-sm";

export function StaffBulkSheet({
  academyId,
  existing,
  roles,
  canSetRole,
  viewer,
  onCloseAction,
  onSavedAction,
}: {
  academyId: string;
  existing: ExistingStaffPhoneRow[];
  roles: AcademyRoleVM[];
  canSetRole: boolean;
  viewer: PermissionViewer | null;
  onCloseAction: () => void;
  onSavedAction: (message: string, closed: boolean) => void;
}) {
  useBodyScrollLock(true);
  const [rows, setRows] = useState<Row[]>(() => [newRow(), newRow()]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const grantable = useMemo(
    () => (canSetRole && viewer ? roles.filter((r) => withinViewerPermissions(viewer, r.permissions)) : []),
    [canSetRole, viewer, roles],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onCloseAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCloseAction, saving]);

  const checked = useMemo(() => {
    const dupIdx = bulkStaffDuplicatePhones(rows.map((r) => (isBlank(r) ? "" : r.phone)));
    return rows.map((r, i) => {
      if (isBlank(r)) return { blank: true as const };
      const errors = validateBulkStaffInput({ displayName: r.displayName, phone: r.phone }).map((e) => e.message);
      if (dupIdx.has(i)) errors.push(BULK_STAFF_MSG.duplicateInTable);
      const conflict = errors.length === 0 ? staffPhoneConflict(existing, r.phone) ?? r.serverConflict : null;
      const ready = errors.length === 0 && (!conflict || r.allowDuplicatePhone);
      return { blank: false as const, errors, conflict, ready };
    });
  }, [rows, existing]);

  const ready = rows.filter((_, i) => {
    const c = checked[i]!;
    return !c.blank && c.ready;
  });
  const errorCount = checked.filter((c) => !c.blank && c.errors.length > 0).length;
  const confirmCount = checked.filter((c) => !c.blank && c.errors.length === 0 && c.conflict && !c.ready).length;

  const update = (key: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch, serverError: null } : r)));

  const save = async () => {
    if (ready.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload: BulkStaffInput[] = ready.map((r) => ({
        rowKey: r.key,
        displayName: r.displayName.trim(),
        phone: r.phone,
        signupRoleId: canSetRole && r.signupRoleId ? r.signupRoleId : null,
        allowDuplicatePhone: r.allowDuplicatePhone,
      }));
      const fn = httpsCallable<{ academyId: string; rows: BulkStaffInput[] }, { results: Result[]; createdCount: number }>(
        getFirebaseFunctions(),
        "createStaffPreRegistrations",
      );
      const res = await fn({ academyId, rows: payload });
      const byKey = new Map(res.data.results.map((r) => [r.rowKey, r]));
      const remaining = rows
        .filter((r) => byKey.get(r.key)?.ok !== true)
        .map((r) => {
          const out = byKey.get(r.key);
          if (!out || out.ok) return r;
          return out.code === "duplicate_phone"
            ? { ...r, serverConflict: out.conflict ?? "pre_registered", allowDuplicatePhone: false, serverError: null }
            : { ...r, serverError: out.message };
        });
      const created = res.data.createdCount;
      const failed = res.data.results.length - created;
      const leftover = remaining.filter((r) => !isBlank(r));
      const message =
        `${created}명을 미리 등록했어요.` + (failed > 0 ? ` 실패 ${failed}줄은 고쳐서 다시 저장해 주세요.` : "");
      if (created > 0) {
        const closed = leftover.length === 0;
        onSavedAction(message, closed);
        if (closed) return;
      }
      setRows(leftover.length > 0 ? remaining : [newRow()]);
      setNotice(message);
    } catch (e) {
      setError(e instanceof FirebaseError && e.message ? e.message : "저장하지 못했어요. 다시 시도해 주세요.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[205] flex flex-col bg-background"
        role="dialog"
        aria-modal="true"
        aria-labelledby="staff-bulk-title"
        data-staff-bulk-sheet
      >
        <header className="shrink-0 border-b border-neutral-200/80 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="mx-auto flex max-w-lg items-center justify-between">
            <h1 id="staff-bulk-title" className="text-lg font-semibold text-foreground">
              직원 여러 명 미리 등록
            </h1>
            <button type="button" onClick={onCloseAction} disabled={saving} className="text-sm text-neutral-500 disabled:opacity-40">
              닫기
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-lg px-4 py-4">
            {/* 저장하는 동안 표 전체 잠금 — 저장 응답은 누를 때의 줄로 남은 줄을 다시 만들기 때문 */}
            <fieldset disabled={saving} aria-busy={saving} className="m-0 min-w-0 space-y-3 border-0 p-0" data-staff-bulk-fieldset>
            <p className="break-keep text-sm text-neutral-600">
              번호와 권한을 미리 등록해 두면, 그 번호로 직원 가입 QR에서 가입하고 문자로 번호를 확인한 직원은 바로 그 권한으로
              이용할 수 있어요. 권한을 비워 두면 가입 승인 대기로 들어옵니다.
            </p>
            {!canSetRole ? (
              <p className="break-keep text-[11px] text-neutral-500">권한은 멤버 관리 권한이 있는 분이 정해요.</p>
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
            <ul className="space-y-2">
              {rows.map((r, i) => {
                const c = checked[i]!;
                const messages = c.blank ? [] : [...c.errors, ...(r.serverError ? [r.serverError] : [])];
                return (
                  <li
                    key={r.key}
                    className="space-y-2 rounded-2xl bg-white/60 p-3 ring-1 ring-black/5 dark:bg-white/[0.04] dark:ring-white/10"
                    data-staff-bulk-row={i}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-neutral-500">{i + 1}</span>
                      <button
                        type="button"
                        aria-label={`${i + 1}번 줄 삭제`}
                        onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((x) => x.key !== r.key) : [newRow()]))}
                        className="h-7 w-7 rounded-lg text-neutral-400 hover:bg-black/[0.04]"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value={r.displayName}
                        onChange={(e) => update(r.key, { displayName: e.target.value })}
                        placeholder="이름*"
                        aria-label={`${i + 1}번 줄 이름`}
                        maxLength={60}
                        className={`${fieldClass} border-neutral-300/70`}
                      />
                      <input
                        value={r.phone}
                        onChange={(e) => update(r.key, { phone: formatKrPhoneInput(e.target.value), serverConflict: null })}
                        placeholder="010-0000-0000*"
                        inputMode="tel"
                        aria-label={`${i + 1}번 줄 휴대폰 번호`}
                        className={`${fieldClass} border-neutral-300/70 font-mono`}
                      />
                    </div>
                    {canSetRole ? (
                      <select
                        value={r.signupRoleId}
                        onChange={(e) => update(r.key, { signupRoleId: e.target.value })}
                        aria-label={`${i + 1}번 줄 가입하면 줄 권한`}
                        className={`${fieldClass} border-neutral-300/70`}
                      >
                        <option value="">가입하면 줄 권한 — 정하지 않음(승인 대기)</option>
                        {grantable.map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    {messages.map((m, mi) => (
                      <p key={mi} className="break-keep text-[11px] text-red-700 dark:text-red-300" data-staff-bulk-error>
                        {m}
                      </p>
                    ))}
                    {!c.blank && c.errors.length === 0 && c.conflict ? (
                      <label className="flex items-start gap-2 text-[11px] text-amber-800 dark:text-amber-300" data-staff-bulk-warning>
                        <input
                          type="checkbox"
                          checked={r.allowDuplicatePhone}
                          onChange={(e) => update(r.key, { allowDuplicatePhone: e.target.checked })}
                          className="mt-0.5"
                        />
                        <span className="break-keep">{staffConflictMessage(c.conflict)} 그래도 저장</span>
                      </label>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              onClick={() => setRows((prev) => (prev.length >= MAX_BULK_STAFF ? prev : [...prev, newRow()]))}
              disabled={rows.length >= MAX_BULK_STAFF}
              className="rounded-[8px] border border-neutral-300/70 bg-white/70 px-3 py-2 text-xs font-medium disabled:opacity-40"
            >
              + 줄 추가
            </button>
            </fieldset>
          </div>
        </main>
        <footer className="shrink-0 border-t border-neutral-200/80 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <div className="mx-auto flex max-w-lg items-center justify-between gap-3">
            <p className="min-w-0 break-keep text-xs text-neutral-600" data-staff-bulk-summary>
              저장할 줄 {ready.length} · 오류 {errorCount} · 확인 필요 {confirmCount}
            </p>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || ready.length === 0}
              className="shrink-0 rounded-2xl bg-[#222] px-5 py-3 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-950"
            >
              {saving ? "저장 중…" : `저장(${ready.length}명)`}
            </button>
          </div>
        </footer>
      </div>
    </ModalPortal>
  );
}
