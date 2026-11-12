"use client";

import { httpsCallable } from "firebase/functions";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ReauthActionForm } from "@/components/account/reauth-action-form";
import { ProcessStatusModal } from "@/components/ui/process-status-modal";
import { SettingsAccordionItem } from "@/components/ui/settings-accordion-item";
import {
  serverReason,
  WITHDRAWAL_TEXT as T,
  WITHDRAWN_ROLE_STORAGE_KEY,
  type WithdrawalRole,
} from "@/lib/auth/account-withdrawal-text";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { reauthenticateRecent, reauthErrorMessage, type ReauthMethod } from "@/lib/firebase/recent-reauth";
import { useBlockUnloadWhile } from "@/lib/ui/use-block-unload";

type WithdrawalInfo = {
  blocked: "admin" | "owns_academies" | null;
  ownedAcademies: { academyId: string; name: string }[];
  memberships: { role: "parent" | "teacher"; academyName: string }[];
  reauth: { memberPassword: boolean; ownerPassword: boolean; google: boolean };
};

const ROLE_LABEL = { parent: "학부모", teacher: "직원" } as const;

/** 세 "내 계정" 맨 아래 — 회원 탈퇴(2-N N2). 접힌 카드라 펼칠 때 정보를 읽는다 */
export function AccountWithdrawalCard({ role }: { role: WithdrawalRole }) {
  return (
    <SettingsAccordionItem title={T.cardTitle}>
      <WithdrawalBody role={role} />
    </SettingsAccordionItem>
  );
}

function WithdrawalBody({ role }: { role: WithdrawalRole }) {
  const router = useRouter();
  const [info, setInfo] = useState<WithdrawalInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [checked, setChecked] = useState(false);
  const [step, setStep] = useState<"info" | "reauth" | "partial">("info");
  const [busy, setBusy] = useState(false);
  /** 서버가 지우는 중(창 닫기 막기·진행 창) — 본인 확인 중에는 띄우지 않음 */
  const [withdrawing, setWithdrawing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useBlockUnloadWhile(withdrawing);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await httpsCallable(getFirebaseFunctions(), "getAccountWithdrawalInfo")({});
      setInfo(res.data as WithdrawalInfo);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const runWithdraw = useCallback(async () => {
    setBusy(true);
    setWithdrawing(true);
    setError(null);
    try {
      await httpsCallable(getFirebaseFunctions(), "withdrawAccount", { timeout: 120_000 })({});
      try {
        sessionStorage.setItem(WITHDRAWN_ROLE_STORAGE_KEY, role);
      } catch {
        /* 무시 — /withdrawn은 역할 없이도 로그아웃 */
      }
      router.replace("/withdrawn");
    } catch (e) {
      const reason = serverReason(e);
      if (reason === "reauth_required") {
        setStep("reauth");
        setError(T.reauthExpired);
      } else if (reason === "owns_academies" || reason === "admin") {
        setStep("info");
        await load();
      } else {
        setStep("partial");
        setError(T.partial);
      }
      setWithdrawing(false);
      setBusy(false);
    }
  }, [load, role, router]);

  const onConfirm = useCallback(
    async (method: ReauthMethod) => {
      setBusy(true);
      setError(null);
      try {
        await reauthenticateRecent(method);
      } catch (e) {
        setError(reauthErrorMessage(e));
        setBusy(false);
        return;
      }
      await runWithdraw();
    },
    [runWithdraw],
  );

  if (loadError) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-red-700">{T.loadError}</p>
        <button type="button" onClick={() => void load()} className="text-sm font-medium text-[#4a90e2]">
          {T.retry}
        </button>
      </div>
    );
  }
  if (!info) return <p className="text-sm text-neutral-500">불러오는 중…</p>;

  if (info.blocked === "admin") {
    return <p className="text-sm text-neutral-700" data-testid="withdrawal-blocked">{T.blockedAdmin}</p>;
  }
  if (info.blocked === "owns_academies") {
    return (
      <div className="space-y-3" data-testid="withdrawal-blocked">
        <p className="break-keep text-sm text-neutral-700">{T.blockedOwner}</p>
        <ul className="space-y-1">
          {info.ownedAcademies.map((a) => (
            <li key={a.academyId} className="rounded-xl bg-black/[0.03] px-3 py-2 text-sm text-foreground dark:bg-white/[0.06]">
              {a.name}
            </li>
          ))}
        </ul>
        <Link
          href="/owner"
          className="block w-full rounded-2xl bg-[#222] py-3 text-center text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-950"
        >
          {T.toAcademyList}
        </Link>
      </div>
    );
  }

  const memberRoles = new Set(info.memberships.map((m) => m.role));
  const keptLines = [
    ...(memberRoles.has("parent") || (role === "parent" && memberRoles.size === 0) ? [T.kept.parent] : []),
    ...(memberRoles.has("teacher") || (role === "teacher" && memberRoles.size === 0) ? [T.kept.teacher] : []),
  ];
  const passwordKind =
    role === "owner" ? (info.reauth.ownerPassword ? "owner" : null) : info.reauth.memberPassword ? "member" : null;

  return (
    <div className="space-y-4" data-testid="withdrawal-body">
      <p className="break-keep text-sm font-medium text-foreground">{T.intro}</p>
      {info.memberships.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs text-neutral-600">{T.membershipsLead}</p>
          <ul className="flex flex-wrap gap-1.5">
            {info.memberships.map((m, i) => (
              <li key={i} className="rounded-full bg-black/[0.04] px-2.5 py-1 text-xs text-foreground dark:bg-white/[0.08]">
                {m.academyName}({ROLE_LABEL[m.role]})
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="text-xs font-semibold text-neutral-700">{T.deletedTitle}</p>
        <p className="break-keep text-sm text-neutral-700">{T.deleted[role]}</p>
      </div>
      <div className="space-y-1">
        <p className="text-xs font-semibold text-neutral-700">{T.keptTitle}</p>
        {keptLines.length > 0 ? (
          keptLines.map((line) => (
            <p key={line} className="break-keep text-sm text-neutral-700">{line}</p>
          ))
        ) : (
          <p className="break-keep text-sm text-neutral-700">{T.keptOwnerNone}</p>
        )}
        {keptLines.length > 0 ? <p className="break-keep text-xs text-neutral-500">{T.keptCommon}</p> : null}
      </div>

      {step === "info" ? (
        <>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="h-4 w-4"
              data-testid="withdrawal-check"
            />
            {T.confirmCheck}
          </label>
          <button
            type="button"
            disabled={!checked}
            onClick={() => {
              setError(null);
              setStep("reauth");
            }}
            className="w-full rounded-2xl border border-red-300/70 py-3 text-sm font-medium text-red-700 disabled:opacity-40"
            data-testid="withdrawal-next"
          >
            {T.next}
          </button>
        </>
      ) : null}

      {step === "reauth" ? (
        <div className="space-y-3 border-t border-black/[0.06] pt-3 dark:border-white/10">
          <p className="text-sm font-semibold text-foreground">{T.reauthTitle}</p>
          <p className="text-xs text-neutral-600">{T.reauthLead}</p>
          <ReauthActionForm
            idPrefix="withdrawal"
            passwordKind={passwordKind}
            google={info.reauth.google}
            submitLabel={T.submit}
            busy={busy}
            onConfirmAction={(m) => void onConfirm(m)}
          />
        </div>
      ) : null}

      {step === "partial" ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void runWithdraw()}
          className="w-full rounded-2xl bg-red-600 py-3 text-sm font-medium text-white disabled:opacity-50"
          data-testid="withdrawal-retry"
        >
          {T.retry}
        </button>
      ) : null}

      {error ? (
        <p className="text-sm text-red-700" role="alert" data-testid="withdrawal-error">
          {error}
        </p>
      ) : null}
      <ProcessStatusModal open={withdrawing} title={T.busy} description="창을 닫지 말아 주세요." animated />
    </div>
  );
}
