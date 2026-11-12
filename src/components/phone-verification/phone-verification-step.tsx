"use client";

import { httpsCallable } from "firebase/functions";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ensureAppCheck, oneShotCallable } from "@/lib/firebase/app-check";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { formatKrPhoneDisplay } from "@/lib/phone/kr-phone";
import {
  isIosUserAgent,
  isMobileUserAgent,
  OCTOMO_INBOUND_DISPLAY,
  OCTOMO_NOTICE,
  smsHref,
  smsQrPayload,
} from "@/lib/phone/phone-verification-ui";
import { signupErrorMessage } from "@/lib/signup/signup-errors";

export type PhoneVerificationPurpose =
  | "parent_signup"
  | "staff_signup"
  | "phone_change"
  /** 2-M 아이디·비밀번호 찾기 — 로그인 전·토큰 없음 */
  | "find_login_id"
  | "reset_password";

type StartRes =
  | { status: "issued"; verificationId: string; code: string; smsTo: string; expiresAtMs: number }
  | { status: "unsupported_phone" | "unavailable" };
type CheckRes =
  | { status: "verified"; proof: string; proofExpiresAtMs: number }
  | { status: "not_found"; remaining: number }
  | { status: "too_soon"; retryAfterMs: number }
  | { status: "expired" | "exhausted" | "unavailable" };

type View =
  | { kind: "starting" }
  | { kind: "issued"; verificationId: string; code: string; note: string | null }
  | { kind: "checking"; verificationId: string; code: string }
  | { kind: "verified" }
  | { kind: "retry"; message: string }
  | { kind: "blocked"; message: string };

export const PHONE_VERIFY_TEXT = {
  title: "휴대폰 번호 확인",
  notFound: (n: number) =>
    `아직 문자를 찾지 못했어요. 전송됐는지 확인하고 잠시 뒤 다시 눌러 주세요. (남은 확인 ${n}번)`,
  tooSoon: "잠시 뒤 다시 눌러 주세요.",
  exhausted: "확인 횟수를 모두 썼어요.",
  expired: "확인 시간이 지났어요.",
  unavailable: "지금은 번호 확인을 할 수 없어요.",
  unsupported: "010으로 시작하는 번호만 문자로 확인할 수 있어요.",
  verified: "번호를 확인했어요.",
} as const;

const btnPrimary =
  "w-full rounded-2xl bg-[#222] py-3.5 text-[15px] font-medium text-white disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-950";
const btnSecondary =
  "w-full rounded-2xl border border-neutral-300/70 py-3 text-sm font-medium text-neutral-700 disabled:opacity-50";

/**
 * 휴대폰 번호 확인 단계(2-L, OCTOMO MO 방식) — 가입 3종·번호 변경 공용.
 * 화면이 열리면 서버가 숫자 6자리를 발급(`startPhoneVerification`, OCTOMO는 부르지 않음).
 * 휴대폰은 [문자 보내기](문자 앱에 1666-3538·숫자를 채움), PC는 QR(휴대폰 카메라로 찍기)·숫자 표시.
 * [문자를 보냈어요]를 누를 때만 서버가 OCTOMO에 조회한다(`checkPhoneVerification`, 1회용 App Check 토큰, 코드당 3번).
 * 확인되면 증표를 `onVerifiedAction`으로 넘긴다. 한도·장애·010이 아닌 번호면 건너뛰기(`allowSkip`) 또는 안내만.
 */
export function PhoneVerificationStep({
  purpose,
  token,
  phone,
  allowSkip,
  skipNote,
  unavailableText = PHONE_VERIFY_TEXT.unavailable,
  onVerifiedAction,
  onSkipAction,
  onEditPhoneAction,
}: {
  purpose: PhoneVerificationPurpose;
  /** 가입 QR 토큰(가입 목적만) */
  token?: string | null;
  /** 확인할 번호(화면 형식) */
  phone: string;
  allowSkip: boolean;
  /** 건너뛰면 어떻게 되는지 한 줄 */
  skipNote?: string;
  /** 한도·장애 문구 — 번호 변경은 "학원에 번호 변경을 요청" 안내까지(건너뛰기 없음) */
  unavailableText?: string;
  onVerifiedAction: (proof: string) => void;
  onSkipAction?: () => void;
  onEditPhoneAction?: () => void;
}) {
  const [view, setView] = useState<View>({ kind: "starting" });
  const [smsOpened, setSmsOpened] = useState(false);
  const [device, setDevice] = useState<{ mobile: boolean; ios: boolean }>({ mobile: false, ios: false });
  const startedFor = useRef<string | null>(null);

  useEffect(() => {
    const ua = navigator.userAgent;
    const touch = navigator.maxTouchPoints ?? 0;
    setDevice({ mobile: isMobileUserAgent(ua, touch), ios: isIosUserAgent(ua, touch) });
  }, []);

  const start = useCallback(async () => {
    setView({ kind: "starting" });
    setSmsOpened(false);
    try {
      await ensureAppCheck();
      const res = await httpsCallable<unknown, StartRes>(getFirebaseFunctions(), "startPhoneVerification")({
        purpose,
        phone,
        ...(token ? { token } : {}),
      });
      const d = res.data;
      if (d.status === "issued") {
        setView({ kind: "issued", verificationId: d.verificationId, code: d.code, note: null });
      } else {
        setView({
          kind: "blocked",
          message: d.status === "unsupported_phone" ? PHONE_VERIFY_TEXT.unsupported : unavailableText,
        });
      }
    } catch (e) {
      setView({ kind: "blocked", message: signupErrorMessage(e, unavailableText) });
    }
  }, [purpose, phone, token, unavailableText]);

  useEffect(() => {
    const key = `${purpose}|${phone}|${token ?? ""}`;
    if (startedFor.current === key) return;
    startedFor.current = key;
    void start();
  }, [purpose, phone, token, start]);

  const check = async () => {
    if (view.kind !== "issued") return;
    const { verificationId, code } = view;
    setView({ kind: "checking", verificationId, code });
    try {
      await ensureAppCheck();
      const res = await oneShotCallable<unknown, CheckRes>("checkPhoneVerification")({ verificationId });
      const d = res.data;
      switch (d.status) {
        case "verified":
          setView({ kind: "verified" });
          onVerifiedAction(d.proof);
          return;
        case "not_found":
          setView({ kind: "issued", verificationId, code, note: PHONE_VERIFY_TEXT.notFound(d.remaining) });
          return;
        case "too_soon":
          setView({ kind: "issued", verificationId, code, note: PHONE_VERIFY_TEXT.tooSoon });
          return;
        case "expired":
          setView({ kind: "retry", message: PHONE_VERIFY_TEXT.expired });
          return;
        case "exhausted":
          setView({ kind: "retry", message: PHONE_VERIFY_TEXT.exhausted });
          return;
        default:
          setView({ kind: "blocked", message: unavailableText });
      }
    } catch (e) {
      setView({ kind: "issued", verificationId, code, note: signupErrorMessage(e, unavailableText) });
    }
  };

  const skipBlock =
    allowSkip && onSkipAction ? (
      <div className="space-y-1.5">
        <button type="button" onClick={onSkipAction} className={btnSecondary} data-phone-verify-skip>
          번호 확인 없이 계속
        </button>
        {skipNote ? <p className="break-keep text-center text-[11px] text-neutral-500">{skipNote}</p> : null}
      </div>
    ) : null;

  const displayPhone = formatKrPhoneDisplay(phone);

  return (
    <div className="space-y-4" data-phone-verify={view.kind}>
      <div className="text-center">
        <p className="text-sm font-semibold text-foreground">{PHONE_VERIFY_TEXT.title}</p>
        {view.kind === "issued" || view.kind === "checking" ? null : (
          <p className="mt-1 font-mono text-sm text-neutral-600">{displayPhone}</p>
        )}
      </div>

      {view.kind === "starting" ? (
        <p className="text-center text-sm text-neutral-500">확인 숫자를 받는 중…</p>
      ) : null}

      {view.kind === "issued" || view.kind === "checking" ? (
        <>
          <p className="break-keep text-center text-sm text-neutral-700">
            <strong>{displayPhone}</strong>에서 <strong>{OCTOMO_INBOUND_DISPLAY}</strong>로 아래 숫자를 문자로 보내 주세요.
          </p>
          <p
            className="text-center font-mono text-3xl font-semibold tracking-[0.3em] text-foreground"
            data-phone-verify-code
          >
            {view.code}
          </p>
          {device.mobile ? (
            <a
              href={smsHref(view.code, device.ios)}
              onClick={() => setSmsOpened(true)}
              className={`${btnPrimary} block text-center`}
              data-phone-verify-sms
            >
              문자 보내기
            </a>
          ) : null}
          {device.mobile && !smsOpened ? (
            <p className="break-keep text-center text-[11px] text-neutral-500">
              문자 앱이 열리지 않으면 {OCTOMO_INBOUND_DISPLAY}로 위 숫자를 직접 보낸 뒤{" "}
              <button type="button" onClick={() => setSmsOpened(true)} className="underline">
                직접 보냈어요
              </button>
              를 눌러 주세요.
            </p>
          ) : null}
          {device.mobile ? null : (
            <div className="flex flex-col items-center gap-2 rounded-2xl bg-white px-3 py-4 ring-1 ring-neutral-200">
              <QRCodeSVG value={smsQrPayload(view.code)} size={168} marginSize={2} level="M" data-phone-verify-qr />
              <p className="break-keep text-center text-[11px] text-neutral-500">
                휴대폰 카메라로 QR을 찍으면 문자 앱이 열려요. 또는 {OCTOMO_INBOUND_DISPLAY}로 <strong>{view.code}</strong>을(를)
                보내 주세요.
              </p>
            </div>
          )}
          <button
            type="button"
            onClick={() => void check()}
            disabled={view.kind === "checking" || (device.mobile && !smsOpened)}
            className={device.mobile ? btnSecondary : btnPrimary}
            data-phone-verify-check
          >
            {view.kind === "checking" ? "확인하는 중…" : "문자를 보냈어요"}
          </button>
          {view.kind === "issued" && view.note ? (
            <p className="break-keep text-center text-xs text-red-700" role="status">
              {view.note}
            </p>
          ) : null}
          <p className="break-keep text-center text-[11px] text-neutral-500">
            10분 안에 보내 주세요. 문자 요금은 이용 중인 요금제에 따릅니다.
          </p>
          {skipBlock}
        </>
      ) : null}

      {view.kind === "retry" ? (
        <>
          <p className="break-keep text-center text-sm text-red-700" role="alert">
            {view.message}
          </p>
          <button type="button" onClick={() => void start()} className={btnPrimary}>
            새 숫자 받기
          </button>
          {skipBlock}
        </>
      ) : null}

      {view.kind === "blocked" ? (
        <>
          <p className="break-keep text-center text-sm text-red-700" role="alert">
            {view.message}
          </p>
          {skipBlock}
        </>
      ) : null}

      {view.kind === "verified" ? (
        <p className="text-center text-sm font-medium text-emerald-700" role="status">
          {PHONE_VERIFY_TEXT.verified}
        </p>
      ) : null}

      {onEditPhoneAction && view.kind !== "verified" ? (
        <button type="button" onClick={onEditPhoneAction} className="w-full text-center text-xs text-neutral-500 underline">
          번호 고치기
        </button>
      ) : null}

      <p className="break-keep text-center text-[11px] text-neutral-400">{OCTOMO_NOTICE}</p>
    </div>
  );
}
