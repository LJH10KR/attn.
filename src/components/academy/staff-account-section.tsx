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
import { staffAccountLabel, type StaffRowVM } from "@/lib/academy/staff-row";
import type { AcademyRoleVM } from "@/lib/academy/use-academy-roles";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { formatKrPhoneDisplay } from "@/lib/phone/kr-phone";

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
  /** 가입 승인 대기 계정과 같은 번호로 미리 등록한 직원(멤버 화면이 계산, 2-K) */
  signupMatches?: StaffRowVM[];
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
 * 계정 없음: 미리 등록(가입하면 줄 권한)·계정 직접 만들기 / 승인 대기: (번호 일치 후보면 이 직원으로 승인)·새 직원으로 승인·거절 /
 * 첫 로그인 전: 임시 비밀번호 재발급·삭제 / 사용 중: 비밀번호 초기화·비활성 / 비활성: 다시 활성화·삭제, 계정이 있으면 역할 바꾸기.
 */
export function StaffAccountSection({
  academyId,
  target,
  roles,
  viewer,
  onChangedAction: notifyChanged,
  onCloseSheetAction,
  signupMatches = [],
}: StaffAccountSectionProps) {
  const [inviteRoleId, setInviteRoleId] = useState(target.signupRoleId ?? "teacher");
  const [nextRoleId, setNextRoleId] = useState(target.roleId ?? "");
  // 목록 새로고침으로 역할이 바뀌면 선택도 맞춤(시트는 열린 채라 다시 마운트되지 않음)
  const [syncedRoleId, setSyncedRoleId] = useState(target.roleId);
  if (syncedRoleId !== target.roleId) {
    setSyncedRoleId(target.roleId);
    setNextRoleId(target.roleId ?? "");
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const savePreRegistration = async (roleId: string | null) => {
    const data = await call("setStaffSignupRole", { staffId: target.id, roleId }, "미리 등록을 저장하지 못했습니다.");
    if (data) {
      const roleName = roles?.find((r) => r.id === roleId)?.name;
      onChangedAction(
        roleId ? `${name} 님을 미리 등록했습니다(권한 「${roleName ?? roleId}」).` : `${name} 님의 미리 등록을 해제했습니다.`,
      );
    }
  };

  const approveAsExisting = async (hr: StaffRowVM) => {
    const hrName = hr.displayName || "(이름 없음)";
    if (
      !window.confirm(
        `${name} 님을 미리 등록한 ${hrName} 님으로 승인할까요? 직원 관리의 인사 정보와 권한이 이 계정에 합쳐지고 바로 이용할 수 있습니다.`,
      )
    ) {
      return;
    }
    const data = await call(
      "approveStaffSignupAsExisting",
      { staffAuthUid: target.id, hrStaffId: hr.id },
      "승인하지 못했습니다.",
    );
    if (data) onChangedAction(`${name} 님을 ${hrName} 님으로 승인했습니다.`);
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
  const canInvite =
    canManage && !hasAccount && target.employmentStatus !== "resigned" && !target.isGuest;
  const canChange =
    canManage && hasAccount && canChangeStaffAccount(viewer, { id: target.id, permissions: target.permissions });
  const grantableRoles = canManage
    ? roles.filter((r) => withinViewerPermissions(viewer, r.permissions))
    : [];
  const currentRoleName = roles?.find((r) => r.id === target.roleId)?.name ?? null;
  const roleById = (id: string | null) => roles?.find((r) => r.id === id) ?? null;
  const presetRoleName = target.signupRoleId ? (roleById(target.signupRoleId)?.name ?? "지워진 권한(기본으로)") : null;
  /** 후보를 합칠 때 줄 역할 — 미리 등록 역할(없거나 지워졌으면 기본 "선생님") */
  const matchRole = (hr: StaffRowVM) => roleById(hr.signupRoleId) ?? roleById("teacher");
  const showMatches = canManage && target.accountStatus === "pending_registration" && signupMatches.length > 0;

  return (
    <section className="space-y-3 rounded-2xl border border-neutral-200/80 bg-white/40 px-4 py-3 text-xs text-neutral-600">
      <div className="space-y-1">
        <p>
          계정: <span className="font-medium text-foreground">{staffAccountLabel(target)}</span>
        </p>
        {target.accountStatus === "pending_registration" && target.phone ? (
          <p>
            가입할 때 적은 번호: <span className="font-mono text-foreground">{formatKrPhoneDisplay(target.phone)}</span>
          </p>
        ) : null}
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
          <div className="space-y-1 rounded-xl bg-white/60 px-3 py-2 ring-1 ring-neutral-200/70">
            <p>
              미리 등록:{" "}
              {presetRoleName ? (
                <span className="font-medium text-foreground">권한 {presetRoleName}</span>
              ) : (
                <span className="text-neutral-500">안 함</span>
              )}
              {" · "}번호{" "}
              <span className="font-mono text-foreground">{formatKrPhoneDisplay(target.phone) || "없음"}</span>
            </p>
            {!target.phone ? (
              <p className="break-keep text-[11px] text-amber-800">
                번호를 입력해 두면 직원 가입 QR로 가입한 사람과 번호로 맞춰 볼 수 있어요(인사 정보에서 입력).
              </p>
            ) : (
              <p className="break-keep text-[11px] text-neutral-500">
                같은 번호로 직원 가입 QR에서 가입하면, 승인 화면에서 「이 직원으로 승인」으로 인사 정보와 권한을 합칠 수 있어요.
              </p>
            )}
          </div>
          <div>
            <label htmlFor="staff-invite-role" className="mb-1 block font-medium text-neutral-600">
              가입하면 줄 권한 · 직접 만들 때 권한
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

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={primaryBtn}
              disabled={busy || !inviteRoleId || inviteRoleId === target.signupRoleId}
              onClick={() => void savePreRegistration(inviteRoleId)}
            >
              {target.signupRoleId ? "미리 등록 권한 바꾸기" : "미리 등록"}
            </button>
            {target.signupRoleId ? (
              <button type="button" className={dangerBtn} disabled={busy} onClick={() => void savePreRegistration(null)}>
                미리 등록 해제
              </button>
            ) : null}
            <button type="button" className={btn} disabled={busy} onClick={() => void createAccount()}>
              계정 직접 만들기
            </button>
          </div>
          <p className="text-[11px] text-neutral-500">
            휴대폰이 없거나 가입이 어려우면 계정을 직접 만들어 로그인 ID·임시 비밀번호를 전달해 주세요.
          </p>
        </>
      ) : null}

      {showMatches ? (
        <div className="space-y-2">
          {signupMatches.map((hr) => {
            const role = matchRole(hr);
            const grantable = role ? withinViewerPermissions(viewer, role.permissions) : false;
            return (
              <div
                key={hr.id}
                className="space-y-2 rounded-xl bg-sky-50 px-3 py-2 ring-1 ring-sky-200"
                data-signup-match={hr.id}
              >
                <p className="break-keep text-sky-950">
                  미리 등록한 <span className="font-semibold">{hr.displayName || "(이름 없음)"}</span>
                  (권한 {role?.name ?? "선생님"})과 번호가 같습니다.
                </p>
                <button
                  type="button"
                  className={primaryBtn}
                  disabled={busy || !grantable}
                  onClick={() => void approveAsExisting(hr)}
                >
                  이 직원으로 승인
                </button>
                {!grantable ? (
                  <p className="text-[11px] text-sky-900/80">본인보다 넓은 권한이라 이 직원으로 승인할 수 없습니다.</p>
                ) : null}
              </div>
            );
          })}
        </div>
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
                <button
                  type="button"
                  className={showMatches ? btn : primaryBtn}
                  disabled={busy}
                  onClick={() => void approve()}
                >
                  {showMatches ? "새 직원으로 승인" : "가입 승인"}
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
        <p className="text-neutral-500">퇴사 처리된 직원은 미리 등록하거나 계정을 만들 수 없습니다.</p>
      ) : null}
      {!canManage ? (
        <p className="text-neutral-500">미리 등록·계정과 권한은 멤버 초대/권한 관리 권한이 있어야 설정할 수 있습니다.</p>
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
