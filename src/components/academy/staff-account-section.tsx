"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useState } from "react";
import { TempCredentialsDialog, type TempCredentialRow } from "@/components/academy/temp-credentials-dialog";
import {
  canChangeStaffAccount,
  withinViewerPermissions,
  type PermissionViewer,
} from "@/lib/academy/role-policy";
import {
  staffAccountLabel,
  staffHasPendingInvite,
  type StaffRowVM,
} from "@/lib/academy/staff-row";
import type { AcademyRoleVM } from "@/lib/academy/use-academy-roles";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";

type StaffAccountSectionProps = {
  academyId: string;
  target: StaffRowVM;
  /** null이면 멤버 초대/권한 관리 권한 없음 — 상태만 보여 줌 */
  roles: AcademyRoleVM[] | null;
  /** 본인·더 넓은 권한 직원이면 버튼을 숨김(실제 차단은 서버) */
  viewer: PermissionViewer | null;
  /** 직원 목록 새로고침(시트는 열어 둠) */
  onChangedAction: (message: string) => void;
  /** 계정을 만들어 직원 문서가 옮겨졌거나 삭제됐을 때 — 시트를 닫아야 함 */
  onCloseSheetAction: (message: string) => void;
};

const btn =
  "rounded-xl border border-neutral-300/70 bg-white/70 px-3 py-2 text-xs font-medium text-foreground disabled:opacity-50";
const primaryBtn =
  "rounded-xl bg-[#222] px-3 py-2 text-xs font-medium text-white disabled:opacity-50";
const dangerBtn = `${btn} text-red-700`;
const selectClass =
  "w-full rounded-xl border border-neutral-300/60 bg-white/70 px-3 py-2 text-sm text-foreground";

function errMsg(err: unknown, fallback: string): string {
  return err instanceof FirebaseError && err.message ? err.message : fallback;
}

function formatExpiry(ms: number): string {
  return new Date(ms).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type IssuedCredentials = {
  title: string;
  description: string;
  row: TempCredentialRow;
  /** 확인 후 시트를 닫을지(계정을 새로 만들어 문서가 옮겨진 경우) */
  closeSheet: boolean;
  message: string;
};

/**
 * 직원 계정 영역 — 직원 관리 시트와 멤버 초대/권한 관리 시트가 함께 씀.
 * 계정 없음: 초대 링크·계정 직접 만들기 / 승인 대기: 승인·거절 / 첫 로그인 전: 임시 비밀번호 재발급·삭제 /
 * 사용 중: 비밀번호 초기화·비활성 / 비활성: 다시 활성화·삭제, 계정이 있으면 역할 바꾸기.
 */
export function StaffAccountSection({
  academyId,
  target,
  roles,
  viewer,
  onChangedAction: notifyChanged,
  onCloseSheetAction,
}: StaffAccountSectionProps) {
  const [inviteRoleId, setInviteRoleId] = useState(target.inviteRoleId ?? "teacher");
  const [nextRoleId, setNextRoleId] = useState(target.roleId ?? "");
  // 목록 새로고침으로 역할이 바뀌면 선택도 맞춤(시트는 열린 채라 다시 마운트되지 않음)
  const [syncedRoleId, setSyncedRoleId] = useState(target.roleId);
  if (syncedRoleId !== target.roleId) {
    setSyncedRoleId(target.roleId);
    setNextRoleId(target.roleId ?? "");
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ url: string; expiresAtMillis: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [credentials, setCredentials] = useState<IssuedCredentials | null>(null);
  /** 시트 안에서도 결과가 보이게(목록 알림은 시트 뒤에 가려짐) */
  const [done, setDone] = useState<string | null>(null);

  const onChangedAction = (message: string) => {
    setDone(message);
    notifyChanged(message);
  };

  const name = target.displayName || "(이름 없음)";

  const call = async <T,>(fnName: string, data: Record<string, unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await httpsCallable(getFirebaseFunctions(), fnName)({ academyId, ...data });
      return res.data as T;
    } catch (e) {
      setError(errMsg(e, fallback));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const createInvite = async () => {
    const data = await call<{ url: string; expiresAtMillis: number }>(
      "createStaffInvite",
      { staffId: target.id, roleId: inviteRoleId },
      "초대 링크를 만들지 못했습니다.",
    );
    if (data) {
      setInvite(data);
      setCopied(false);
      onChangedAction(`${name} 님의 초대 링크를 만들었습니다.`);
    }
  };

  const shareInvite = async () => {
    if (!invite) return;
    const text = `${name} 님, attn. 직원 초대 링크입니다. 링크에서 가입해 주세요.`;
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "attn. 직원 초대", text, url: invite.url });
      } catch {
        /* 공유 취소 — 복사로 대체하지 않음 */
      }
      return;
    }
    await navigator.clipboard.writeText(invite.url);
    setCopied(true);
  };

  const cancelInvite = async () => {
    if (!window.confirm("보낸 초대 링크를 취소할까요? 이미 보낸 링크로는 가입할 수 없게 됩니다.")) return;
    const data = await call("cancelStaffInvite", { staffId: target.id }, "초대를 취소하지 못했습니다.");
    if (data) {
      setInvite(null);
      onChangedAction(`${name} 님의 초대를 취소했습니다.`);
    }
  };

  const createAccount = async () => {
    if (!window.confirm(`${name} 님의 계정을 바로 만들까요? 로그인 ID와 임시 비밀번호는 한 번만 보여 드립니다.`)) {
      return;
    }
    const data = await call<{ accounts: { loginId: string; tempPassword?: string }[] }>(
      "createStaffAccounts",
      { items: [{ staffId: target.id, roleId: inviteRoleId }] },
      "계정을 만들지 못했습니다.",
    );
    const account = data?.accounts?.[0];
    if (account?.tempPassword) {
      setCredentials({
        title: "계정을 만들었습니다",
        description: `${name} 님에게 아래 정보를 전달해 주세요. 첫 로그인 때 비밀번호를 바꾸면 바로 이용할 수 있습니다.`,
        row: { displayName: name, loginId: account.loginId, tempPassword: account.tempPassword },
        closeSheet: true,
        message: `${name} 님의 계정을 만들었습니다.`,
      });
    }
  };

  const approve = async () => {
    const data = await call("activateTeacher", { teacherAuthUid: target.id }, "승인하지 못했습니다.");
    if (data) onChangedAction(`${name} 님의 가입을 승인했습니다.`);
  };

  const reactivate = async () => {
    const data = await call("activateTeacher", { teacherAuthUid: target.id }, "활성화하지 못했습니다.");
    if (data) onChangedAction(`${name} 님의 계정을 다시 활성화했습니다.`);
  };

  const deactivate = async () => {
    if (!window.confirm(`${name} 님의 계정을 비활성화할까요? 바로 로그인할 수 없게 됩니다.`)) return;
    const data = await call("deactivateTeacher", { teacherAuthUid: target.id }, "비활성화하지 못했습니다.");
    if (data) onChangedAction(`${name} 님의 계정을 비활성화했습니다.`);
  };

  /**
   * reject: 가입 거절 / cancel: 첫 로그인 전 계정 취소 — 직원 정보까지 전체 삭제
   * delete: 써 오던(비활성) 계정 — 서버가 로그인 계정만 지우고 인사 기록은 "계정 없음" 직원으로 남김
   */
  const removeAccount = async (kind: "reject" | "cancel" | "delete") => {
    const question = {
      reject: `${name} 님의 가입 신청을 거절할까요? 만들어진 계정이 삭제됩니다.`,
      cancel: `${name} 님의 계정을 삭제할까요? 아직 첫 로그인 전이라 직원 정보도 함께 삭제되며 되돌릴 수 없습니다.`,
      delete: `${name} 님의 로그인 계정을 삭제할까요? 인사 기록은 직원 관리에 「계정 없음」으로 남고, 나중에 다시 초대할 수 있습니다.`,
    }[kind];
    if (!window.confirm(question)) return;
    const data = await call(
      "deleteTeacherInvite",
      { teacherId: target.id },
      kind === "reject" ? "거절하지 못했습니다." : "삭제하지 못했습니다.",
    );
    if (data) {
      onCloseSheetAction(
        {
          reject: `${name} 님의 가입 신청을 거절했습니다.`,
          cancel: `${name} 님의 계정과 직원 정보를 삭제했습니다.`,
          delete: `${name} 님의 로그인 계정을 삭제했습니다. 인사 기록은 직원 관리에 남아 있습니다.`,
        }[kind],
      );
    }
  };

  const issueTempPassword = async (kind: "regenerate" | "reset") => {
    if (
      kind === "reset" &&
      !window.confirm(
        `${name} 님의 비밀번호를 초기화할까요? 지금 쓰던 비밀번호와 로그인 중인 기기는 바로 로그아웃되고, 새 임시 비밀번호로 첫 로그인부터 다시 해야 합니다.`,
      )
    ) {
      return;
    }
    const data = await call<{ loginId?: string; attnId?: string; tempPassword?: string }>(
      kind === "reset" ? "resetMemberPassword" : "regenerateMemberTempPassword",
      { memberAuthUid: target.id, role: "teacher" },
      kind === "reset" ? "비밀번호를 초기화하지 못했습니다." : "임시 비밀번호를 만들지 못했습니다.",
    );
    if (data?.tempPassword) {
      setCredentials({
        title: kind === "reset" ? "비밀번호를 초기화했습니다" : "임시 비밀번호를 다시 만들었습니다",
        description: `${name} 님에게 새 임시 비밀번호를 전달해 주세요. 이전 임시 비밀번호는 더 이상 쓸 수 없습니다.`,
        row: {
          displayName: name,
          loginId: data.loginId || target.loginId || data.attnId || "",
          tempPassword: data.tempPassword,
        },
        closeSheet: false,
        message:
          kind === "reset"
            ? `${name} 님의 비밀번호를 초기화했습니다.`
            : `${name} 님의 임시 비밀번호를 다시 만들었습니다.`,
      });
    }
  };

  const changeRole = async () => {
    const role = roles?.find((r) => r.id === nextRoleId);
    if (!role) return;
    const data = await call("assignStaffRole", { staffId: target.id, roleId: role.id }, "권한을 바꾸지 못했습니다.");
    if (data) onChangedAction(`${name} 님의 권한을 「${role.name}」(으)로 바꿨습니다.`);
  };

  const canManage = roles !== null && viewer !== null;
  const hasAccount = target.accountStatus !== "no_account";
  const pendingInvite = staffHasPendingInvite(target);
  const canInvite =
    canManage && !hasAccount && target.employmentStatus !== "resigned";
  const canChange =
    canManage && hasAccount && canChangeStaffAccount(viewer, { id: target.id, permissions: target.permissions });
  const grantableRoles = canManage
    ? roles.filter((r) => withinViewerPermissions(viewer, r.permissions))
    : [];
  const currentRoleName = roles?.find((r) => r.id === target.roleId)?.name ?? null;

  return (
    <section className="space-y-3 rounded-2xl border border-neutral-200/80 bg-white/40 px-4 py-3 text-xs text-neutral-600">
      <div className="space-y-1">
        <p>
          계정: <span className="font-medium text-foreground">{staffAccountLabel(target)}</span>
          {pendingInvite && target.inviteExpiresAtMillis ? (
            <span className="text-neutral-500"> · {formatExpiry(target.inviteExpiresAtMillis)}까지 유효</span>
          ) : null}
        </p>
        {hasAccount ? (
          <p>
            로그인:{" "}
            <span className="font-mono text-foreground">
              {target.loginId || (target.authProvider === "google" ? "Google 계정" : "—")}
            </span>
            {currentRoleName ? (
              <>
                {" "}
                · 권한 <span className="font-medium text-foreground">{currentRoleName}</span>
              </>
            ) : null}
          </p>
        ) : null}
      </div>

      {canInvite ? (
        <>
          <div>
            <label htmlFor="staff-invite-role" className="mb-1 block font-medium text-neutral-600">
              부여할 권한
            </label>
            <select
              id="staff-invite-role"
              value={inviteRoleId}
              disabled={busy}
              onChange={(e) => setInviteRoleId(e.target.value)}
              className={selectClass}
            >
              {grantableRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>

          {invite ? (
            <div className="space-y-2 rounded-xl bg-sky-50 px-3 py-2 ring-1 ring-sky-200">
              <p className="text-sky-950">
                초대 링크가 만들어졌습니다. {formatExpiry(invite.expiresAtMillis)}까지 한 번 사용할 수 있어요.
              </p>
              <p className="break-all font-mono text-[11px] text-sky-900">{invite.url}</p>
              <div className="flex gap-2">
                <button type="button" className={primaryBtn} onClick={() => void shareInvite()}>
                  공유하기
                </button>
                <button
                  type="button"
                  className={btn}
                  onClick={() => {
                    void navigator.clipboard.writeText(invite.url);
                    setCopied(true);
                  }}
                >
                  {copied ? "복사됨" : "링크 복사"}
                </button>
              </div>
              <p className="text-[11px] text-sky-900/80">
                받은 사람이 가입하면 「가입 승인 대기」가 되고, 승인해야 이용할 수 있습니다.
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryBtn} disabled={busy} onClick={() => void createInvite()}>
              {pendingInvite || invite ? "초대 링크 다시 만들기" : "초대 링크 만들기"}
            </button>
            <button type="button" className={btn} disabled={busy} onClick={() => void createAccount()}>
              계정 직접 만들기
            </button>
            {pendingInvite || invite ? (
              <button type="button" className={dangerBtn} disabled={busy} onClick={() => void cancelInvite()}>
                초대 취소
              </button>
            ) : null}
          </div>
          <p className="text-[11px] text-neutral-500">
            다시 만들면 이전 링크는 쓸 수 없습니다. 링크는 보안을 위해 만들 때 한 번만 보여 드립니다.
          </p>
        </>
      ) : null}

      {canChange ? (
        <>
          <div>
            <label htmlFor="staff-account-role" className="mb-1 block font-medium text-neutral-600">
              권한
            </label>
            <div className="flex gap-2">
              <select
                id="staff-account-role"
                value={nextRoleId}
                disabled={busy}
                onChange={(e) => setNextRoleId(e.target.value)}
                className={selectClass}
              >
                {target.roleId && !grantableRoles.some((r) => r.id === target.roleId) ? (
                  <option value={target.roleId} disabled>
                    {currentRoleName ?? "알 수 없는 권한"}
                  </option>
                ) : null}
                {grantableRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={`${primaryBtn} shrink-0`}
                disabled={busy || !nextRoleId || nextRoleId === target.roleId}
                onClick={() => void changeRole()}
              >
                바꾸기
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {target.accountStatus === "pending_registration" ? (
              <>
                <button type="button" className={primaryBtn} disabled={busy} onClick={() => void approve()}>
                  가입 승인
                </button>
                <button type="button" className={dangerBtn} disabled={busy} onClick={() => void removeAccount("reject")}>
                  가입 거절
                </button>
              </>
            ) : null}
            {target.accountStatus === "pending_setup" ? (
              <>
                <button
                  type="button"
                  className={btn}
                  disabled={busy}
                  onClick={() => void issueTempPassword("regenerate")}
                >
                  임시 비밀번호 다시 만들기
                </button>
                <button type="button" className={dangerBtn} disabled={busy} onClick={() => void removeAccount("cancel")}>
                  계정 삭제
                </button>
              </>
            ) : null}
            {target.accountStatus === "active" ? (
              <>
                {target.loginId ? (
                  <button type="button" className={btn} disabled={busy} onClick={() => void issueTempPassword("reset")}>
                    비밀번호 초기화
                  </button>
                ) : null}
                <button type="button" className={dangerBtn} disabled={busy} onClick={() => void deactivate()}>
                  비활성화
                </button>
              </>
            ) : null}
            {target.accountStatus === "inactive" ? (
              <>
                <button type="button" className={primaryBtn} disabled={busy} onClick={() => void reactivate()}>
                  다시 활성화
                </button>
                <button type="button" className={dangerBtn} disabled={busy} onClick={() => void removeAccount("delete")}>
                  계정 삭제
                </button>
              </>
            ) : null}
          </div>
          {target.accountStatus === "active" && target.loginId ? (
            <p className="text-[11px] text-neutral-500">
              비밀번호를 잊었다면 초기화해 새 임시 비밀번호를 전달해 주세요. 받은 사람은 첫 로그인처럼 비밀번호를 새로 정합니다.
            </p>
          ) : null}
        </>
      ) : null}

      {canManage && hasAccount && !canChange ? (
        <p className="text-neutral-500">
          {target.id === viewer.uid
            ? "본인 계정의 권한·상태는 여기서 바꿀 수 없습니다."
            : "본인보다 넓은 권한을 가진 직원의 계정은 바꿀 수 없습니다."}
        </p>
      ) : null}
      {!hasAccount && target.employmentStatus === "resigned" ? (
        <p className="text-neutral-500">퇴사 처리된 직원은 초대할 수 없습니다.</p>
      ) : null}
      {!canManage ? (
        <p className="text-neutral-500">계정 초대와 권한은 멤버 초대/권한 관리 권한이 있어야 설정할 수 있습니다.</p>
      ) : null}

      {error ? (
        <p className="text-red-700" role="alert">
          {error}
        </p>
      ) : null}
      {done && !error ? (
        <p className="rounded-xl bg-emerald-500/10 px-3 py-2 text-emerald-900 ring-1 ring-emerald-500/20" role="status">
          {done}
        </p>
      ) : null}

      {credentials ? (
        <TempCredentialsDialog
          title={credentials.title}
          description={credentials.description}
          rows={[credentials.row]}
          onConfirmAction={() => {
            const { closeSheet, message } = credentials;
            setCredentials(null);
            if (closeSheet) onCloseSheetAction(message);
            else onChangedAction(message);
          }}
        />
      ) : null}
    </section>
  );
}
