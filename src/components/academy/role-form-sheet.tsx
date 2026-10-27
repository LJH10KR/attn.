"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useEffect, useState } from "react";
import { ModalPortal } from "@/components/ui/modal-portal";
import {
  ACADEMY_PERMISSION_GROUPS,
  ACADEMY_PERMISSIONS,
  type AcademyPermission,
} from "@/lib/academy/permissions";
import { canEditRole, withinViewerPermissions, type PermissionViewer } from "@/lib/academy/role-policy";
import type { AcademyRoleVM } from "@/lib/academy/use-academy-roles";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

/** 서버 `roles.ts`와 같은 한도 */
const MAX_ROLE_NAME_LENGTH = 30;

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-sm text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50 focus:bg-white/70";

/** 권한별 보충 설명 — 메뉴 이름만으로 범위가 애매한 것만 */
const PERMISSION_HINTS: Partial<Record<AcademyPermission, string>> = {
  "billing.refunds": "결제를 실제로 취소합니다",
  "settings.members": "멤버 초대·승인·권한 지정",
};

function errMsg(err: unknown, fallback: string): string {
  return err instanceof FirebaseError && err.message ? err.message : fallback;
}

type RoleFormSheetProps = {
  academyId: string;
  /** null이면 새 권한 만들기 */
  role: AcademyRoleVM | null;
  viewer: PermissionViewer;
  onCloseAction: () => void;
  onSavedAction: (message: string) => void;
};

/**
 * 권한(역할) 만들기·수정 전체 화면 시트 — 메뉴 그룹은 `ACADEMY_PERMISSION_GROUPS`.
 * 직원은 본인이 가진 권한만 고를 수 있고, 본인 역할·더 넓은 역할은 보기만 한다(실제 차단은 서버).
 */
export function RoleFormSheet({ academyId, role, viewer, onCloseAction, onSavedAction }: RoleFormSheetProps) {
  useBodyScrollLock(true);
  const [name, setName] = useState(role?.name ?? "");
  const [selected, setSelected] = useState<Set<AcademyPermission>>(() => new Set(role?.permissions ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editable = role === null || canEditRole(viewer, role);
  const canGrant = (p: AcademyPermission) => withinViewerPermissions(viewer, [p]);
  const deletable = editable && role !== null && role.template === null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCloseAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCloseAction]);

  const toggle = (p: AcademyPermission, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(p);
      else next.delete(p);
      return next;
    });
  };

  const onSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > MAX_ROLE_NAME_LENGTH) {
      setError(`권한 이름을 1~${MAX_ROLE_NAME_LENGTH}자로 입력해 주세요.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await httpsCallable(getFirebaseFunctions(), "saveAcademyRole")({
        academyId,
        roleId: role?.id ?? null,
        name: trimmed,
        permissions: ACADEMY_PERMISSIONS.filter((p) => selected.has(p)),
      });
      onSavedAction(role ? `「${trimmed}」 권한을 저장했습니다.` : `「${trimmed}」 권한을 만들었습니다.`);
    } catch (e) {
      setError(errMsg(e, "저장하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!role || !window.confirm(`「${role.name}」 권한을 삭제할까요?`)) return;
    setBusy(true);
    setError(null);
    try {
      await httpsCallable(getFirebaseFunctions(), "deleteAcademyRole")({ academyId, roleId: role.id });
      onSavedAction(`「${role.name}」 권한을 삭제했습니다.`);
    } catch (e) {
      setError(errMsg(e, "삭제하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[200] flex flex-col bg-background"
        role="dialog"
        aria-modal="true"
        aria-labelledby="role-form-title"
      >
        <header className="shrink-0 border-b border-neutral-200/80 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="mx-auto flex max-w-lg items-center justify-between">
            <h1 id="role-form-title" className="text-lg font-semibold text-foreground">
              {role ? (editable ? "권한 수정" : "권한 보기") : "권한 만들기"}
            </h1>
            <button
              type="button"
              onClick={onCloseAction}
              disabled={busy}
              className="text-sm text-neutral-500 hover:text-foreground"
            >
              닫기
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-lg space-y-4 px-4 py-5">
            {!editable ? (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
                {role?.id === viewer.roleId
                  ? "본인에게 배정된 권한은 바꿀 수 없습니다."
                  : "본인보다 넓은 권한은 수정하거나 삭제할 수 없습니다."}
              </p>
            ) : null}

            <div>
              <label htmlFor="role-name" className="mb-1 block text-xs font-medium text-neutral-600">
                권한 이름 <span className="text-red-600">*</span>
              </label>
              <input
                id="role-name"
                value={name}
                maxLength={MAX_ROLE_NAME_LENGTH}
                disabled={!editable}
                onChange={(e) => setName(e.target.value)}
                className={inputClass}
                placeholder="예: 수납 담당"
              />
              {role?.template && editable ? (
                <p className="mt-1 text-[11px] text-neutral-500">기본 권한이라 삭제할 수 없지만 이름과 메뉴는 바꿀 수 있어요.</p>
              ) : null}
            </div>

            {ACADEMY_PERMISSION_GROUPS.map((group) => {
              const keys = group.permissions.map((p) => p.key);
              const grantableKeys = keys.filter(canGrant);
              const allOn = grantableKeys.length > 0 && grantableKeys.every((k) => selected.has(k));
              return (
                <fieldset key={group.tab} className="rounded-2xl border border-neutral-200/80 bg-white/40 px-4 py-3">
                  <legend className="sr-only">{group.label}</legend>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-foreground">{group.label}</span>
                    {editable && grantableKeys.length > 0 ? (
                      <button
                        type="button"
                        className="text-[11px] text-[#4a90e2] underline"
                        onClick={() => {
                          for (const k of grantableKeys) toggle(k, !allOn);
                        }}
                      >
                        {allOn ? "모두 끄기" : "모두 켜기"}
                      </button>
                    ) : null}
                  </div>
                  <ul className="mt-2 space-y-1">
                    {group.permissions.map((p) => {
                      const grantable = canGrant(p.key);
                      return (
                        <li key={p.key}>
                          <label
                            className={`flex items-center gap-3 rounded-xl px-1 py-1.5 text-sm ${
                              editable && grantable ? "text-foreground" : "text-neutral-400"
                            }`}
                          >
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-[#222]"
                              checked={selected.has(p.key)}
                              disabled={!editable || !grantable}
                              onChange={(e) => toggle(p.key, e.target.checked)}
                            />
                            <span className="min-w-0 flex-1">
                              {p.label}
                              {PERMISSION_HINTS[p.key] ? (
                                <span className="ml-1.5 text-[11px] text-neutral-500">{PERMISSION_HINTS[p.key]}</span>
                              ) : null}
                            </span>
                            {editable && !grantable ? (
                              <span className="text-[10px] text-neutral-400">내 권한 밖</span>
                            ) : null}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              );
            })}

            <p className="text-[11px] text-neutral-500">
              아무 메뉴도 켜지 않으면 담당 반·학생만 보는 선생님 권한이 됩니다. 저장하면 이 권한을 쓰는 멤버에게 바로 적용됩니다.
            </p>

            {error ? (
              <p className="text-sm text-red-700" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </main>

        {editable ? (
          <footer className="shrink-0 border-t border-neutral-200/80 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
            <div className="mx-auto flex max-w-lg gap-2">
              {deletable ? (
                <button
                  type="button"
                  disabled={busy || role.memberCount > 0}
                  title={role.memberCount > 0 ? "이 권한을 쓰는 멤버가 있어 삭제할 수 없습니다." : undefined}
                  onClick={() => void onDelete()}
                  className="rounded-2xl border border-red-200 px-4 py-3 text-sm font-medium text-red-700 disabled:opacity-40"
                >
                  삭제
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => void onSubmit()}
                className="flex-1 rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? "저장 중…" : "저장"}
              </button>
            </div>
            {deletable && role.memberCount > 0 ? (
              <p className="mx-auto mt-2 max-w-lg text-[11px] text-neutral-500">
                멤버 {role.memberCount}명이 쓰고 있어 삭제하려면 먼저 다른 권한으로 바꿔 주세요.
              </p>
            ) : null}
          </footer>
        ) : null}
      </div>
    </ModalPortal>
  );
}
