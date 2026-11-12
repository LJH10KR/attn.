"use client";

import { httpsCallable } from "firebase/functions";
import { useCallback, useMemo, useState } from "react";
import { ReauthActionForm } from "@/components/account/reauth-action-form";
import { ProcessStatusModal } from "@/components/ui/process-status-modal";
import { ACADEMY_DELETE_TEXT as T, serverReason } from "@/lib/auth/account-withdrawal-text";
import { downloadAcademyPaymentsCsv } from "@/lib/academy/payments-csv";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { reauthenticateRecent, reauthErrorMessage, type ReauthMethod } from "@/lib/firebase/recent-reauth";
import { useBlockUnloadWhile } from "@/lib/ui/use-block-unload";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50";

/** 서버 학원 삭제는 학원 규모에 따라 오래 걸림(함수 제한 540초와 같게) */
const DELETE_TIMEOUT_MS = 540_000;

/**
 * 원장 학원 삭제(2-N N6~N8) — ① 경고·결제 내역 내려받기·학원 이름 입력 ② 본인 확인 → `deleteOwnerAcademy`(최근 인증 5분).
 * 즉시 파기·되돌릴 수 없음. 중간에 멈추면 [다시 시도]가 같은 호출로 이어서 지운다. 지우는 동안 창 닫기를 막는다.
 */
export function AcademyDeleteDialog({
  academy,
  onCloseAction,
  onDeletedAction,
}: {
  academy: { id: string; name: string };
  onCloseAction: () => void;
  /** 삭제 끝(또는 이미 삭제됨) — 목록 새로 고침과 알림 문구 */
  onDeletedAction: (message: string) => void;
}) {
  const [step, setStep] = useState<"warn" | "reauth" | "failed">("warn");
  const [nameInput, setNameInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvMessage, setCsvMessage] = useState<string | null>(null);
  useBlockUnloadWhile(deleting);

  const nameOk = nameInput.trim() === academy.name.trim() && nameInput.trim().length > 0;
  const methods = useMemo(() => {
    const providers = getFirebaseAuth().currentUser?.providerData.map((p) => p.providerId) ?? [];
    return { password: providers.includes("password"), google: providers.includes("google.com") };
  }, []);

  const onCsv = useCallback(async () => {
    setCsvBusy(true);
    setCsvMessage(null);
    try {
      const n = await downloadAcademyPaymentsCsv(academy.id, academy.name);
      setCsvMessage(n === 0 ? T.paymentsNone : T.paymentsDone(n));
    } catch {
      setCsvMessage(T.paymentsError);
    } finally {
      setCsvBusy(false);
    }
  }, [academy.id, academy.name]);

  const runDelete = useCallback(async () => {
    setBusy(true);
    setDeleting(true);
    setError(null);
    try {
      await httpsCallable(getFirebaseFunctions(), "deleteOwnerAcademy", { timeout: DELETE_TIMEOUT_MS })({
        academyId: academy.id,
        confirmName: nameInput.trim(),
      });
      setDeleting(false);
      onDeletedAction(T.done(academy.name));
      return;
    } catch (e) {
      const reason = serverReason(e);
      const code = (e as { code?: string }).code;
      if (reason === "reauth_required") {
        setStep("reauth");
        setError(reauthErrorMessage(e));
      } else if (reason === "name_mismatch") {
        setStep("warn");
        setError(T.nameMismatch);
      } else if (code === "functions/not-found") {
        setDeleting(false);
        onDeletedAction(T.alreadyDeleted);
        return;
      } else {
        setStep("failed");
        setError(T.failed);
      }
    }
    setDeleting(false);
    setBusy(false);
  }, [academy.id, academy.name, nameInput, onDeletedAction]);

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
      await runDelete();
    },
    [runDelete],
  );

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-black/25 p-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-title"
      data-testid="academy-delete-dialog"
    >
      <div className="glass-card my-auto w-full max-w-md space-y-4 p-6">
        <h3 id="delete-title" className="text-lg font-semibold text-foreground">
          {T.title}
        </h3>
        <p className="break-keep text-sm font-medium text-red-800">{T.warning(academy.name)}</p>
        <p className="break-keep text-sm text-neutral-600">{T.accounts}</p>

        {step === "warn" ? (
          <>
            <div className="space-y-2 rounded-2xl bg-black/[0.03] p-3 dark:bg-white/[0.06]">
              <p className="break-keep text-xs text-neutral-700">{T.payments}</p>
              <button
                type="button"
                disabled={csvBusy}
                onClick={() => void onCsv()}
                className="w-full rounded-xl border border-neutral-300/70 bg-white/60 py-2.5 text-sm font-medium text-foreground disabled:opacity-50 dark:bg-white/[0.08]"
                data-testid="academy-delete-csv"
              >
                {csvBusy ? T.paymentsBusy : T.paymentsButton}
              </button>
              {csvMessage ? (
                <p className="text-xs text-neutral-600" data-testid="academy-delete-csv-message">
                  {csvMessage}
                </p>
              ) : null}
            </div>
            <div>
              <label htmlFor="academy-delete-name" className="mb-1 block text-xs font-medium text-neutral-600">
                {T.nameLabel}
              </label>
              <input
                id="academy-delete-name"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                className={inputClass}
                placeholder={academy.name}
                autoComplete="off"
              />
            </div>
          </>
        ) : null}

        {step === "reauth" ? (
          <div className="space-y-2">
            <p className="text-xs text-neutral-600">{T.reauthLead}</p>
            <ReauthActionForm
              idPrefix="academy-delete"
              passwordKind={methods.password ? "owner" : null}
              google={methods.google}
              submitLabel={T.submit}
              busy={busy}
              onConfirmAction={(m) => void onConfirm(m)}
            />
          </div>
        ) : null}

        {error ? (
          <p className="text-sm text-red-700" role="alert" data-testid="academy-delete-error">
            {error}
          </p>
        ) : null}

        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCloseAction}
            className="flex-1 rounded-2xl border border-neutral-300/70 py-3 text-sm font-medium text-neutral-700 disabled:opacity-50"
          >
            {T.cancel}
          </button>
          {step === "warn" ? (
            <button
              type="button"
              disabled={!nameOk}
              onClick={() => {
                setError(null);
                setStep("reauth");
              }}
              className="flex-1 rounded-2xl bg-red-600 py-3 text-sm font-medium text-white disabled:opacity-40"
              data-testid="academy-delete-next"
            >
              {T.next}
            </button>
          ) : null}
          {step === "failed" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void runDelete()}
              className="flex-1 rounded-2xl bg-red-600 py-3 text-sm font-medium text-white disabled:opacity-50"
              data-testid="academy-delete-retry"
            >
              {T.retry}
            </button>
          ) : null}
        </div>
      </div>
      <ProcessStatusModal open={deleting} title={T.busy} description="학원 규모에 따라 몇 분 걸릴 수 있어요." animated />
    </div>
  );
}
