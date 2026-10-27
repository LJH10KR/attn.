"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useState } from "react";
import { ModalPortal } from "@/components/ui/modal-portal";
import {
  staffAccountLabel,
  staffHasPendingInvite,
  type StaffRowVM,
} from "@/lib/academy/staff-row";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";

export type StaffRoleOption = { id: string; name: string };

type StaffAccountSectionProps = {
  academyId: string;
  target: StaffRowVM;
  /** null이면 멤버 초대/권한 관리 권한 없음 — 상태만 보여 줌 */
  roles: StaffRoleOption[] | null;
  /** 직원 목록 새로고침(시트는 열어 둠) */
  onChangedAction: (message: string) => void;
  /** 계정을 만들어 직원 문서가 옮겨졌을 때 — 시트를 닫아야 함 */
  onAccountCreatedAction: (message: string) => void;
};

const btn =
  "rounded-xl border border-neutral-300/70 bg-white/70 px-3 py-2 text-xs font-medium text-foreground disabled:opacity-50";
const primaryBtn =
  "rounded-xl bg-[#222] px-3 py-2 text-xs font-medium text-white disabled:opacity-50";

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

/**
 * 직원 시트의 계정 영역 — 계정 없는 직원에게 초대 링크(가입 후 승인) 또는 계정 직접 만들기,
 * 초대 링크로 가입한 직원은 승인·거절. 활성 계정의 권한 변경은 멤버 관리에서.
 */
export function StaffAccountSection({
  academyId,
  target,
  roles,
  onChangedAction,
  onAccountCreatedAction,
}: StaffAccountSectionProps) {
  const [roleId, setRoleId] = useState(target.inviteRoleId ?? "teacher");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ url: string; expiresAtMillis: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [credentials, setCredentials] = useState<{ loginId: string; tempPassword: string } | null>(
    null,
  );

  const call = async <T,>(name: string, data: Record<string, unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await httpsCallable(getFirebaseFunctions(), name)({ academyId, ...data });
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
      { staffId: target.id, roleId },
      "초대 링크를 만들지 못했습니다.",
    );
    if (data) {
      setInvite(data);
      setCopied(false);
      onChangedAction(`${target.displayName} 님의 초대 링크를 만들었습니다.`);
    }
  };

  const shareInvite = async () => {
    if (!invite) return;
    const text = `${target.displayName} 님, attn. 직원 초대 링크입니다. 링크에서 가입해 주세요.`;
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "attn. 직원 초대", text, url: invite.url });
        return;
      } catch {
        /* 공유 취소 — 복사로 대체하지 않음 */
        return;
      }
    }
    await navigator.clipboard.writeText(invite.url);
    setCopied(true);
  };

  const cancelInvite = async () => {
    if (!window.confirm("보낸 초대 링크를 취소할까요? 이미 보낸 링크로는 가입할 수 없게 됩니다.")) return;
    const data = await call("cancelStaffInvite", { staffId: target.id }, "초대를 취소하지 못했습니다.");
    if (data) {
      setInvite(null);
      onChangedAction(`${target.displayName} 님의 초대를 취소했습니다.`);
    }
  };

  const createAccount = async () => {
    if (
      !window.confirm(
        `${target.displayName} 님의 계정을 바로 만들까요? 로그인 ID와 임시 비밀번호는 한 번만 보여 드립니다.`,
      )
    ) {
      return;
    }
    const data = await call<{ accounts: { loginId: string; tempPassword?: string }[] }>(
      "createStaffAccounts",
      { items: [{ staffId: target.id, roleId }] },
      "계정을 만들지 못했습니다.",
    );
    const account = data?.accounts?.[0];
    if (account?.tempPassword) {
      setCredentials({ loginId: account.loginId, tempPassword: account.tempPassword });
    }
  };

  const approve = async () => {
    const data = await call("activateTeacher", { teacherAuthUid: target.id }, "승인하지 못했습니다.");
    if (data) onAccountCreatedAction(`${target.displayName} 님의 가입을 승인했습니다.`);
  };

  const reject = async () => {
    if (!window.confirm(`${target.displayName} 님의 가입 신청을 거절할까요? 만들어진 계정이 삭제됩니다.`)) {
      return;
    }
    const data = await call("deleteTeacherInvite", { teacherId: target.id }, "거절하지 못했습니다.");
    if (data) onAccountCreatedAction(`${target.displayName} 님의 가입 신청을 거절했습니다.`);
  };

  const canManage = roles !== null;
  const pendingInvite = staffHasPendingInvite(target);
  const canInvite =
    canManage && target.accountStatus === "no_account" && target.employmentStatus !== "resigned";

  return (
    <section className="space-y-3 rounded-2xl border border-neutral-200/80 bg-white/40 px-4 py-3 text-xs text-neutral-600">
      <p>
        계정: <span className="font-medium text-foreground">{staffAccountLabel(target)}</span>
        {pendingInvite && target.inviteExpiresAtMillis ? (
          <span className="text-neutral-500"> · {formatExpiry(target.inviteExpiresAtMillis)}까지 유효</span>
        ) : null}
      </p>

      {canInvite ? (
        <>
          <div>
            <label htmlFor="staff-role" className="mb-1 block font-medium text-neutral-600">
              부여할 권한
            </label>
            <select
              id="staff-role"
              value={roleId}
              disabled={busy}
              onChange={(e) => setRoleId(e.target.value)}
              className="w-full rounded-xl border border-neutral-300/60 bg-white/70 px-3 py-2 text-sm text-foreground"
            >
              {roles.map((r) => (
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
              <button type="button" className={`${btn} text-red-700`} disabled={busy} onClick={() => void cancelInvite()}>
                초대 취소
              </button>
            ) : null}
          </div>
          <p className="text-[11px] text-neutral-500">
            다시 만들면 이전 링크는 쓸 수 없습니다. 링크는 보안을 위해 만들 때 한 번만 보여 드립니다.
          </p>
        </>
      ) : null}

      {canManage && target.accountStatus === "pending_registration" ? (
        <div className="flex gap-2">
          <button type="button" className={primaryBtn} disabled={busy} onClick={() => void approve()}>
            가입 승인
          </button>
          <button type="button" className={`${btn} text-red-700`} disabled={busy} onClick={() => void reject()}>
            가입 거절
          </button>
        </div>
      ) : null}

      {target.accountStatus === "no_account" && target.employmentStatus === "resigned" ? (
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

      {credentials ? (
        <ModalPortal>
          <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true">
            <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl">
              <h3 className="text-base font-semibold text-foreground">계정을 만들었습니다</h3>
              <p className="mt-2 text-xs text-neutral-600">
                {target.displayName} 님에게 아래 정보를 전달해 주세요. 첫 로그인 때 비밀번호를 바꾸면 바로 이용할 수
                있습니다. 이 창을 닫으면 임시 비밀번호는 다시 볼 수 없습니다.
              </p>
              <dl className="mt-4 space-y-2 rounded-2xl bg-amber-50 px-4 py-3 font-mono text-sm text-amber-950 ring-1 ring-amber-200">
                <div className="flex justify-between gap-3">
                  <dt className="font-sans text-xs text-amber-900">로그인 ID</dt>
                  <dd>{credentials.loginId}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="font-sans text-xs text-amber-900">임시 비밀번호</dt>
                  <dd>{credentials.tempPassword}</dd>
                </div>
              </dl>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  className={`${btn} flex-1 py-3`}
                  onClick={() =>
                    void navigator.clipboard.writeText(
                      `로그인 ID: ${credentials.loginId}\n임시 비밀번호: ${credentials.tempPassword}`,
                    )
                  }
                >
                  복사
                </button>
                <button
                  type="button"
                  className={`${primaryBtn} flex-1 py-3`}
                  onClick={() => onAccountCreatedAction(`${target.displayName} 님의 계정을 만들었습니다.`)}
                >
                  확인
                </button>
              </div>
            </div>
          </div>
        </ModalPortal>
      ) : null}
    </section>
  );
}
