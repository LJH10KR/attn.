"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useEffect, useState } from "react";
import { AcademySignupLinkCard } from "@/components/academy/academy-signup-link-card";
import { TempCredentialsDialog, type TempCredentialRow } from "@/components/academy/temp-credentials-dialog";
import { ModalPortal } from "@/components/ui/modal-portal";
import { withinViewerPermissions, type PermissionViewer } from "@/lib/academy/role-policy";
import type { StaffRowVM } from "@/lib/academy/staff-row";
import type { AcademyRoleVM } from "@/lib/academy/use-academy-roles";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

/** 서버 `createStaffAccounts`와 같은 한도 */
const MAX_INVITES = 10;
const MAX_NAME_LENGTH = 60;
const NEW_STAFF = "__new__";

type InviteMode = "qr" | "account";

type InviteRow = { key: number; staffId: string; displayName: string; roleId: string };

type MemberInviteSheetProps = {
  academyId: string;
  roles: AcademyRoleVM[];
  viewer: PermissionViewer;
  /** 계정 없는 직원(퇴사·게스트 제외) — 이미 등록된 직원을 골라 계정을 만듦 */
  candidates: StaffRowVM[];
  onCloseAction: () => void;
  /** 계정이 만들어졌을 때 목록 새로고침(시트는 열어 둠) */
  onCreatedAction: () => void;
};

const inputClass =
  "w-full rounded-xl border border-neutral-300/60 bg-white/70 px-3 py-2 text-sm text-foreground outline-none focus:border-[#4a90e2]/50";
const btn =
  "rounded-xl border border-neutral-300/70 bg-white/70 px-3 py-2 text-xs font-medium text-foreground disabled:opacity-50";

function errMsg(err: unknown, fallback: string): string {
  return err instanceof FirebaseError && err.message ? err.message : fallback;
}

/**
 * 멤버 초대 시트(2-K) — 두 갈래.
 * 직원 가입 QR: 학원 공용 직원 가입 링크(받은 사람이 가입 → 승인 대기, 번호가 미리 등록한 직원과 같으면 승인 때 합칠 수 있음).
 * 계정 직접 만들기: 최대 10명, 로그인 ID·임시 비밀번호 즉시 발급(휴대폰이 없거나 가입이 어려운 사람용).
 * 새 이름이면 직원 목록에도 추가되고, 계정 없는 기존 직원을 고를 수도 있다.
 */
export function MemberInviteSheet({
  academyId,
  roles,
  viewer,
  candidates,
  onCloseAction,
  onCreatedAction,
}: MemberInviteSheetProps) {
  useBodyScrollLock(true);
  const grantable = roles.filter((r) => withinViewerPermissions(viewer, r.permissions));
  const defaultRoleId = grantable.some((r) => r.id === "teacher") ? "teacher" : (grantable[0]?.id ?? "");

  const [mode, setMode] = useState<InviteMode>("qr");
  const [rows, setRows] = useState<InviteRow[]>([
    { key: 0, staffId: NEW_STAFF, displayName: "", roleId: defaultRoleId },
  ]);
  const [nextKey, setNextKey] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<TempCredentialRow[] | null>(null);
  const [failures, setFailures] = useState<{ displayName: string; message: string }[]>([]);
  /** 임시 비밀번호 창이 떠 있는 동안은 시트를 닫지 않음 */
  const showingCredentials = issued !== null && issued.length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !showingCredentials) onCloseAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, showingCredentials, onCloseAction]);

  const candidateName = (id: string) => candidates.find((c) => c.id === id)?.displayName ?? "";
  const rowName = (r: InviteRow) => (r.staffId === NEW_STAFF ? r.displayName.trim() : candidateName(r.staffId));
  const updateRow = (key: number, patch: Partial<InviteRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const addRow = () => {
    if (rows.length >= MAX_INVITES) return;
    const last = rows[rows.length - 1];
    setRows((prev) => [
      ...prev,
      { key: nextKey, staffId: NEW_STAFF, displayName: "", roleId: last?.roleId ?? defaultRoleId },
    ]);
    setNextKey((k) => k + 1);
  };

  const validate = (): string | null => {
    const picked = new Set<string>();
    for (const [i, r] of rows.entries()) {
      if (r.staffId === NEW_STAFF) {
        const name = r.displayName.trim();
        if (!name || name.length > MAX_NAME_LENGTH) return `${i + 1}번째 이름을 1~${MAX_NAME_LENGTH}자로 입력해 주세요.`;
      } else {
        if (picked.has(r.staffId)) return `${candidateName(r.staffId)} 님을 두 번 고르셨습니다.`;
        picked.add(r.staffId);
      }
      if (!r.roleId) return `${i + 1}번째 권한을 골라 주세요.`;
    }
    return null;
  };

  const target = (r: InviteRow) =>
    r.staffId === NEW_STAFF ? { displayName: r.displayName.trim(), roleId: r.roleId } : { staffId: r.staffId, roleId: r.roleId };

  const submitAccounts = async () => {
    const fn = httpsCallable(getFirebaseFunctions(), "createStaffAccounts");
    try {
      const res = await fn({ academyId, items: rows.map(target) });
      const data = res.data as {
        accounts: { index: number; displayName: string; loginId: string; tempPassword?: string }[];
        failures?: { index: number; displayName: string; message: string }[];
      };
      setIssued(
        data.accounts.flatMap((a) =>
          a.tempPassword ? [{ displayName: a.displayName, loginId: a.loginId, tempPassword: a.tempPassword }] : [],
        ),
      );
      setFailures(
        (data.failures ?? []).map((f) => ({
          displayName: f.displayName || (rows[f.index] ? rowName(rows[f.index]) : ""),
          message: f.message,
        })),
      );
      onCreatedAction();
    } catch (e) {
      setError(errMsg(e, "계정을 만들지 못했습니다."));
    }
  };

  const onSubmit = async () => {
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    if (!window.confirm(`${rows.length}명의 계정을 바로 만들까요? 임시 비밀번호는 한 번만 보여 드립니다.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await submitAccounts();
    } finally {
      setBusy(false);
    }
  };

  const showForm = issued === null;

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[200] flex flex-col bg-background"
        role="dialog"
        aria-modal="true"
        aria-labelledby="member-invite-title"
      >
        <header className="shrink-0 border-b border-neutral-200/80 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="mx-auto flex max-w-lg items-center justify-between">
            <h1 id="member-invite-title" className="text-lg font-semibold text-foreground">
              멤버 초대
            </h1>
            <button
              type="button"
              onClick={onCloseAction}
              disabled={busy || showingCredentials}
              className="text-sm text-neutral-500 hover:text-foreground disabled:opacity-50"
            >
              닫기
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-lg space-y-4 px-4 py-5">
            {showForm ? (
              <>
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="초대 방법">
                  {(
                    [
                      { id: "qr", label: "직원 가입 QR", hint: "받은 사람이 가입 → 승인 후 이용" },
                      { id: "account", label: "계정 직접 만들기", hint: "로그인 ID·임시 비밀번호 즉시 발급" },
                    ] as const
                  ).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={mode === m.id}
                      onClick={() => setMode(m.id)}
                      className={`rounded-2xl border px-3 py-2.5 text-left transition ${
                        mode === m.id
                          ? "border-[#222] bg-[#222] text-white"
                          : "border-neutral-300/70 bg-white/60 text-neutral-700"
                      }`}
                    >
                      <span className="block text-sm font-medium">{m.label}</span>
                      <span className={`mt-0.5 block text-[10px] ${mode === m.id ? "text-white/75" : "text-neutral-500"}`}>
                        {m.hint}
                      </span>
                    </button>
                  ))}
                </div>

                {mode === "qr" ? (
                  <>
                    <AcademySignupLinkCard academyId={academyId} kind="staff" />
                    <p className="break-keep text-[11px] text-neutral-500">
                      직원 관리에서 번호와 「가입하면 줄 권한」을 미리 등록해 두면, 같은 번호로 가입한 사람을 승인할 때
                      「이 직원으로 승인」으로 인사 정보와 권한을 합칠 수 있어요.
                    </p>
                  </>
                ) : (
                  <>
                  <ol className="space-y-2">
                    {rows.map((r, i) => (
                      <li key={r.key} className="space-y-2 rounded-2xl border border-neutral-200/80 bg-white/40 p-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-neutral-600">{i + 1}</span>
                          {rows.length > 1 ? (
                            <button
                              type="button"
                              className="text-[11px] text-neutral-500 underline"
                              onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}
                            >
                              빼기
                            </button>
                          ) : null}
                        </div>
                        {candidates.length > 0 ? (
                          <select
                            aria-label={`${i + 1}번째 직원`}
                            value={r.staffId}
                            onChange={(e) => updateRow(r.key, { staffId: e.target.value })}
                            className={inputClass}
                          >
                            <option value={NEW_STAFF}>새 직원 (이름 입력)</option>
                            {candidates.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.displayName || "(이름 없음)"} · 직원 목록
                              </option>
                            ))}
                          </select>
                        ) : null}
                        {r.staffId === NEW_STAFF ? (
                          <input
                            aria-label={`${i + 1}번째 이름`}
                            value={r.displayName}
                            maxLength={MAX_NAME_LENGTH}
                            onChange={(e) => updateRow(r.key, { displayName: e.target.value })}
                            className={inputClass}
                            placeholder="이름 (예: 김선생)"
                          />
                        ) : null}
                        <select
                          aria-label={`${i + 1}번째 권한`}
                          value={r.roleId}
                          onChange={(e) => updateRow(r.key, { roleId: e.target.value })}
                          className={inputClass}
                        >
                          {grantable.map((role) => (
                            <option key={role.id} value={role.id}>
                              {role.name}
                            </option>
                          ))}
                        </select>
                      </li>
                    ))}
                  </ol>

                  <button
                    type="button"
                    className={`${btn} w-full py-3`}
                    disabled={rows.length >= MAX_INVITES}
                    onClick={addRow}
                  >
                    {rows.length >= MAX_INVITES ? `한 번에 최대 ${MAX_INVITES}명까지` : "+ 한 명 더"}
                  </button>
                  <p className="text-[11px] text-neutral-500">
                    계정을 받은 사람은 첫 로그인 때 비밀번호를 새로 정하면 바로 이용할 수 있습니다. 새 이름은 직원 관리
                    목록에도 추가됩니다.
                  </p>
                  </>
                )}
              </>
            ) : null}

            {failures.length > 0 ? (
              <div className="space-y-1 rounded-2xl bg-red-500/10 px-3 py-3 text-xs text-red-800 ring-1 ring-red-500/15">
                <p className="font-medium">만들지 못한 계정 {failures.length}명</p>
                {failures.map((f, i) => (
                  <p key={i}>
                    {f.displayName || "(이름 없음)"} — {f.message}
                  </p>
                ))}
              </div>
            ) : null}

            {error ? (
              <p className="text-sm text-red-700" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </main>

        <footer className="shrink-0 border-t border-neutral-200/80 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <div className="mx-auto flex max-w-lg gap-2">
            {showForm && mode === "account" ? (
              <button
                type="button"
                disabled={busy || grantable.length === 0}
                onClick={() => void onSubmit()}
                className="flex-1 rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? "만드는 중…" : `계정 ${rows.length}개 만들기`}
              </button>
            ) : (
              <button
                type="button"
                onClick={onCloseAction}
                className="flex-1 rounded-2xl bg-[#222] py-3 text-sm font-medium text-white"
              >
                완료
              </button>
            )}
          </div>
        </footer>

        {showingCredentials ? (
          <TempCredentialsDialog
            title={`계정 ${issued.length}개를 만들었습니다`}
            description={
              failures.length > 0
                ? `${failures.length}명은 만들지 못했습니다(시트에서 사유 확인). 만든 계정의 정보를 각 직원에게 전달해 주세요.`
                : "각 직원에게 로그인 ID와 임시 비밀번호를 전달해 주세요."
            }
            rows={issued ?? []}
            onConfirmAction={() => {
              if (failures.length === 0) onCloseAction();
              else setIssued([]);
            }}
          />
        ) : null}
      </div>
    </ModalPortal>
  );
}
