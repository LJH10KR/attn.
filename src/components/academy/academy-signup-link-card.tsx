"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { QRCodeCanvas } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModalPortal } from "@/components/ui/modal-portal";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { getPublicAppOrigin } from "@/lib/firebase/config";

export type SignupLinkKind = "parent" | "staff";

const btnClass =
  "rounded-[8px] border border-neutral-300/70 bg-white/70 px-3 py-2 text-xs font-medium text-foreground disabled:opacity-50";
const primaryBtnClass =
  "rounded-[8px] bg-[#222] px-3 py-2 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-950";

const TEXT: Record<
  SignupLinkKind,
  { title: string; hint: string; shareTitle: string; shareText: string; fileName: string; who: string }
> = {
  parent: {
    title: "학부모 가입 QR",
    hint: "이 QR·링크로만 가입할 수 있어요. 가입하면 승인 대기로 들어오고, 학원이 연결하면 자녀가 보입니다.",
    shareTitle: "학부모 회원 가입",
    shareText: "학원 학부모 앱 가입 링크입니다.",
    fileName: "학부모-가입-QR.png",
    who: "학부모",
  },
  staff: {
    title: "직원 가입 QR",
    hint: "이 QR·링크로만 가입할 수 있어요. 가입하면 「가입 승인 대기」로 들어오고, 멤버 목록에서 승인해야 이용할 수 있습니다.",
    shareTitle: "attn. 직원 가입",
    shareText: "학원 직원 가입 링크입니다. 가입한 뒤 학원의 승인을 기다려 주세요.",
    fileName: "직원-가입-QR.png",
    who: "직원",
  },
};

type LinkState = { token: string; enabled: boolean };
type Confirm = "regenerate" | "disable";

function errMsg(err: unknown, fallback: string): string {
  return err instanceof FirebaseError && err.message ? err.message : fallback;
}

/**
 * 가입 QR 카드(2-K) — 학부모(홈·학부모 관리)·직원(멤버 초대) 공용.
 * 링크에는 학원 ID가 아닌 무작위 토큰만 들어가고(서버가 처음 볼 때 만듦), 권한 있는 사람만 토큰을 받는다.
 * 공유창·링크 복사·QR(기기 안에서 그림, `<img>`로 보여 길게 눌러 저장)·이미지 저장, [다시 만들기]·[가입 받기 끄기/켜기].
 */
export function AcademySignupLinkCard({ academyId, kind }: { academyId: string; kind: SignupLinkKind }) {
  const text = TEXT[kind];
  const [link, setLink] = useState<LinkState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const qrWrapRef = useRef<HTMLDivElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const callLink = useCallback(
    async (fn: "getSignupLink" | "regenerateSignupLink" | "setSignupLinkEnabled", extra: Record<string, unknown> = {}) => {
      const res = await httpsCallable(getFirebaseFunctions(), fn)({ academyId, kind, ...extra });
      const data = res.data as LinkState;
      setLink({ token: data.token, enabled: data.enabled });
    },
    [academyId, kind],
  );

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      await callLink("getSignupLink");
    } catch (e) {
      setLoadError(errMsg(e, "가입 링크를 불러오지 못했습니다."));
    }
  }, [callLink]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const signupUrl = useMemo(() => {
    if (!link) return "";
    const path = `/join/${kind}?token=${encodeURIComponent(link.token)}`;
    const origin = getPublicAppOrigin();
    return origin ? `${origin}${path}` : path;
  }, [kind, link]);

  const copy = useCallback(async (): Promise<boolean> => {
    if (!signupUrl) return false;
    try {
      await navigator.clipboard.writeText(signupUrl);
      setCopied(true);
      setMessage(null);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
      return true;
    } catch {
      setCopied(false);
      setShowLink(true);
      setMessage("자동 복사가 되지 않습니다. 아래 링크를 길게 눌러 복사해 주세요.");
      return false;
    }
  }, [signupUrl]);

  const share = useCallback(async () => {
    if (!signupUrl) return;
    try {
      await navigator.share({ title: text.shareTitle, text: text.shareText, url: signupUrl });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      await copy();
    }
  }, [copy, signupUrl, text.shareText, text.shareTitle]);

  // 숨긴 캔버스가 그려지면 이미지로 바꾼다(기기 안에서만)
  useEffect(() => {
    if (!qrOpen || !signupUrl) {
      setQrDataUrl(null);
      return;
    }
    const canvas = qrWrapRef.current?.querySelector("canvas");
    if (!canvas) return;
    try {
      setQrDataUrl(canvas.toDataURL("image/png"));
    } catch {
      setQrDataUrl(null);
    }
  }, [qrOpen, signupUrl]);

  const saveQr = useCallback(() => {
    if (!qrDataUrl) return;
    try {
      const a = document.createElement("a");
      a.href = qrDataUrl;
      a.download = text.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setMessage("이미지를 저장하지 못했습니다. QR을 길게 눌러 저장하거나 화면을 캡처해 주세요.");
    }
  }, [qrDataUrl, text.fileName]);

  const runAction = async (action: () => Promise<void>, done: string, fallback: string): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      setMessage(done);
      setShowLink(false);
      setCopied(false);
      return true;
    } catch (e) {
      setActionError(errMsg(e, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onConfirm = async () => {
    if (confirm === "regenerate") {
      const ok = await runAction(
        () => callLink("regenerateSignupLink"),
        "새 링크를 만들었습니다. 이전 QR·링크는 더 이상 쓸 수 없어요. 새 QR을 다시 공유해 주세요.",
        "링크를 다시 만들지 못했습니다.",
      );
      if (ok) setConfirm(null);
    } else if (confirm === "disable") {
      const ok = await runAction(
        () => callLink("setSignupLinkEnabled", { enabled: false }),
        "가입 받기를 껐습니다.",
        "가입 받기를 끄지 못했습니다.",
      );
      if (ok) setConfirm(null);
    }
  };

  const enable = () =>
    void runAction(() => callLink("setSignupLinkEnabled", { enabled: true }), "가입 받기를 켰습니다.", "가입 받기를 켜지 못했습니다.");

  const confirmText =
    confirm === "regenerate"
      ? {
          title: `${text.who} 가입 링크를 다시 만들까요?`,
          body: `지금 QR·링크는 바로 쓸 수 없게 됩니다. 단톡방 등에 올린 QR도 새로 올려 주세요. 이미 가입한 ${text.who}에게는 영향이 없습니다.`,
          label: "다시 만들기",
        }
      : {
          title: `${text.who} 가입 받기를 끌까요?`,
          body: "켜기 전까지 이 QR로 가입할 수 없습니다. 다시 켜면 같은 QR을 그대로 쓸 수 있습니다.",
          label: "가입 받기 끄기",
        };

  const enabled = link?.enabled ?? true;

  return (
    <div className="glass-card space-y-3 px-4 py-3" data-signup-link-kind={kind}>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">{text.title}</p>
        <p className="break-keep text-[11px] text-neutral-500">{text.hint}</p>
      </div>

      {loadError ? (
        <div className="space-y-2">
          <p className="break-keep text-[11px] text-red-700" role="alert">
            {loadError}
          </p>
          <button type="button" onClick={() => void load()} className={btnClass}>
            다시 시도
          </button>
        </div>
      ) : !link ? (
        <p className="text-[11px] text-neutral-500">링크를 불러오는 중…</p>
      ) : (
        <>
          {!enabled ? (
            <p className="break-keep rounded-xl bg-amber-50 px-3 py-2 text-[11px] text-amber-950 ring-1 ring-amber-200" role="status">
              가입 받기 꺼짐 — 지금은 이 QR로 가입할 수 없습니다.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {canShare ? (
              <button type="button" onClick={() => void share()} className={primaryBtnClass}>
                공유
              </button>
            ) : null}
            <button type="button" onClick={() => void copy()} className={canShare ? btnClass : primaryBtnClass}>
              {copied ? "복사됨" : "링크 복사"}
            </button>
            <button type="button" onClick={() => setQrOpen((v) => !v)} aria-expanded={qrOpen} className={btnClass}>
              {qrOpen ? "QR 닫기" : "QR 보기"}
            </button>
          </div>
          {message ? (
            <p className="break-keep text-[11px] text-emerald-800" role="status">
              {message}
            </p>
          ) : null}
          {showLink ? (
            <p className="select-all break-all rounded-xl bg-white/70 px-3 py-2 font-mono text-[11px] text-foreground ring-1 ring-neutral-200">
              {signupUrl}
            </p>
          ) : null}
          {qrOpen ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl bg-white px-3 py-4 ring-1 ring-neutral-200">
              <div ref={qrWrapRef} hidden aria-hidden>
                <QRCodeCanvas value={signupUrl} size={400} marginSize={2} level="M" />
              </div>
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- 기기 안에서 만든 data URL(최적화 대상 아님)
                <img
                  src={qrDataUrl}
                  alt={`${text.title} 코드`}
                  width={200}
                  height={200}
                  className={`h-[200px] w-[200px] ${enabled ? "" : "opacity-40"}`}
                />
              ) : (
                <div className="flex h-[200px] w-[200px] items-center justify-center text-xs text-neutral-400">
                  QR 만드는 중…
                </div>
              )}
              <p className="break-keep text-center text-[11px] text-neutral-500">
                휴대폰 카메라로 찍으면 가입 화면이 열립니다. 저장이 안 되면 QR을 길게 눌러 저장해 주세요.
              </p>
              <button type="button" onClick={saveQr} disabled={!qrDataUrl} className={btnClass}>
                이미지 저장
              </button>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2 border-t border-neutral-200/70 pt-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setActionError(null);
                setConfirm("regenerate");
              }}
              className={btnClass}
            >
              링크 다시 만들기
            </button>
            {enabled ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setActionError(null);
                  setConfirm("disable");
                }}
                className={`${btnClass} text-red-700`}
              >
                가입 받기 끄기
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={enable} className={primaryBtnClass}>
                {busy ? "켜는 중…" : "가입 받기 켜기"}
              </button>
            )}
          </div>
          {actionError && !confirm ? (
            <p className="break-keep text-[11px] text-red-700" role="alert">
              {actionError}
            </p>
          ) : null}
        </>
      )}

      {confirm ? (
        <ModalPortal>
          <div
            className="fixed inset-0 z-[260] flex items-end justify-center bg-black/40 sm:items-center"
            role="presentation"
            onClick={() => (busy ? undefined : setConfirm(null))}
          >
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="signup-link-confirm-title"
              className="w-full max-w-lg rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-3xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 id="signup-link-confirm-title" className="break-keep text-base font-semibold text-foreground">
                {confirmText.title}
              </h2>
              <p className="mt-2 break-keep text-sm text-neutral-600">{confirmText.body}</p>
              {actionError ? (
                <p className="mt-2 break-keep text-sm text-red-700" role="alert">
                  {actionError}
                </p>
              ) : null}
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirm(null)}
                  className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium disabled:opacity-50"
                >
                  취소
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onConfirm()}
                  className="flex-1 rounded-2xl bg-red-600 py-3 text-sm font-medium text-white disabled:opacity-50"
                >
                  {busy ? "처리 중…" : confirmText.label}
                </button>
              </div>
            </div>
          </div>
        </ModalPortal>
      ) : null}
    </div>
  );
}
