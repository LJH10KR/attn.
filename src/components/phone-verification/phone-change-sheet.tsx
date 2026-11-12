"use client";

import { useEffect, useState } from "react";
import { PhoneVerificationStep } from "@/components/phone-verification/phone-verification-step";
import { KrPhoneInput } from "@/components/ui/kr-phone-input";
import { ModalPortal } from "@/components/ui/modal-portal";
import { signupErrorMessage } from "@/lib/signup/signup-errors";
import { digitsOnly, getKrPhoneValidationError } from "@/lib/phone/kr-phone";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

/** 번호 변경 중 한도·장애(2-L L-3 문구 표) — 건너뛰기 없이 학원에 요청 안내 */
export const PHONE_CHANGE_UNAVAILABLE =
  "지금은 번호 확인을 할 수 없어요. 잠시 후 다시 시도하거나 학원에 번호 변경을 요청해 주세요.";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50 disabled:opacity-60";
const btnPrimary =
  "w-full rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-950";
const btnSecondary =
  "w-full rounded-2xl border border-neutral-300/70 py-3 text-sm font-medium text-neutral-700 disabled:opacity-50";

type Step = { kind: "input" } | { kind: "verify"; phone: string } | { kind: "saving" } | { kind: "error"; message: string };

/**
 * 번호 바꾸기 시트(2-L L-3) — 학부모 설정·직원 설정·학부모 앱 안내 창 [지금 쓰는 번호 확인하기] 공용.
 * 새 번호 입력 → [인증 문자 받기]를 누른 뒤에만 공용 번호 확인 부품을 붙인다(그때 처음 App Check를 켜고 `startPhoneVerification` —
 * 시트를 열기만 하면 reCAPTCHA 0회). 문자 확인이 필수이고 건너뛰기는 없다. 확인되면 증표로 `submitAction`(서버가 한 트랜잭션에서 반영).
 * 지금 번호와 같은 번호는 아직 문자로 확인하지 않은 경우에만 확인할 수 있다(가입 때 건너뛴 번호를 나중에 확인).
 */
export function PhoneChangeSheet({
  title,
  intro,
  initialPhone,
  currentPhone,
  currentVerified,
  submitAction,
  onDoneAction,
  onCloseAction,
}: {
  title: string;
  intro?: string;
  /** 입력 칸 처음 값(화면 형식) — 안내 창은 학원이 적은 번호 */
  initialPhone: string;
  /** 지금 계정 번호 */
  currentPhone: string;
  /** 지금 계정 번호가 문자로 확인된 번호인지 */
  currentVerified: boolean;
  /** 증표로 서버 반영 — 완료 문구를 돌려줌, 실패하면 던짐 */
  submitAction: (phone: string, proof: string) => Promise<string>;
  onDoneAction: (message: string) => void;
  onCloseAction: () => void;
}) {
  useBodyScrollLock(true);
  const [phone, setPhone] = useState(initialPhone);
  const [step, setStep] = useState<Step>({ kind: "input" });
  const busy = step.kind === "saving";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCloseAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCloseAction]);

  const invalid = phone.trim() ? getKrPhoneValidationError(phone) : "새 번호를 입력해 주세요.";
  const sameAsCurrent = digitsOnly(phone) !== "" && digitsOnly(phone) === digitsOnly(currentPhone);
  const blockedSame = sameAsCurrent && currentVerified;

  const onVerified = async (proof: string, verifiedPhone: string) => {
    setStep({ kind: "saving" });
    try {
      onDoneAction(await submitAction(verifiedPhone, proof));
    } catch (e) {
      setStep({ kind: "error", message: signupErrorMessage(e, "번호를 바꾸지 못했습니다. 잠시 후 다시 시도해 주세요.") });
    }
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[270] flex items-end justify-center bg-black/40 sm:items-center"
        role="presentation"
        onClick={() => (busy ? undefined : onCloseAction())}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="phone-change-title"
          className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 pb-[calc(max(1.25rem,env(safe-area-inset-bottom))+30px)] shadow-2xl sm:rounded-3xl sm:pb-5 dark:bg-neutral-900"
          onClick={(e) => e.stopPropagation()}
          data-phone-change-sheet
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 id="phone-change-title" className="text-base font-semibold text-foreground">
              {title}
            </h2>
            <button
              type="button"
              onClick={onCloseAction}
              disabled={busy}
              className="text-sm text-neutral-500 hover:text-foreground disabled:opacity-50"
            >
              닫기
            </button>
          </div>

          {step.kind === "input" ? (
            <div className="space-y-3">
              {intro ? <p className="break-keep text-sm text-neutral-600">{intro}</p> : null}
              <div>
                <label htmlFor="phone-change-input" className="mb-1 block text-xs font-medium text-neutral-600">
                  지금 쓰는 휴대폰 번호
                </label>
                <KrPhoneInput id="phone-change-input" value={phone} onChange={setPhone} className={inputClass} />
              </div>
              {blockedSame ? (
                <p className="break-keep text-xs text-neutral-500">지금 계정 번호와 같아요(문자 확인됨).</p>
              ) : (
                <p className="break-keep text-[11px] text-neutral-500">
                  이 번호의 휴대폰에서 문자를 한 통 보내 번호를 확인해야 바뀌어요.
                </p>
              )}
              <button
                type="button"
                disabled={Boolean(invalid) || blockedSame}
                onClick={() => setStep({ kind: "verify", phone })}
                className={btnPrimary}
                data-phone-change-start
              >
                인증 문자 받기
              </button>
            </div>
          ) : null}

          {step.kind === "verify" ? (
            <PhoneVerificationStep
              purpose="phone_change"
              phone={step.phone}
              allowSkip={false}
              unavailableText={PHONE_CHANGE_UNAVAILABLE}
              onVerifiedAction={(proof) => void onVerified(proof, step.phone)}
              onEditPhoneAction={() => setStep({ kind: "input" })}
            />
          ) : null}

          {step.kind === "saving" ? (
            <p className="py-6 text-center text-sm text-neutral-600" role="status">
              번호를 반영하는 중…
            </p>
          ) : null}

          {step.kind === "error" ? (
            <div className="space-y-3">
              <p className="break-keep text-sm text-red-700" role="alert">
                {step.message}
              </p>
              <button type="button" onClick={() => setStep({ kind: "input" })} className={btnSecondary}>
                번호 다시 입력
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </ModalPortal>
  );
}
