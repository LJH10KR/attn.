"use client";

import { QRCodeCanvas } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPublicAppOrigin } from "@/lib/firebase/config";

const btnClass =
  "rounded-[8px] border border-neutral-300/70 bg-white/70 px-3 py-2 text-xs font-medium text-foreground disabled:opacity-50";
const primaryBtnClass =
  "rounded-[8px] bg-[#222] px-3 py-2 text-xs font-medium text-white dark:bg-neutral-100 dark:text-neutral-950";

/**
 * 학부모 가입 안내(9-5) — 공유창·링크 복사·QR. 서비스가 메시지를 보내지 않는다(견적서 0장).
 * - 공유: `navigator.share`가 있으면 쓰고(취소는 무시), 그 밖 오류·미지원이면 복사, 복사도 안 되면 링크를 선택할 수 있게 보여 준다.
 * - QR은 기기 안에서 그린다(`qrcode.react`) — 가입 링크(학원 ID 포함)를 외부 QR 서비스로 보내지 않는다.
 *   캔버스는 화면에 두지 않고 `toDataURL`로 만든 `<img>`로 보여 준다(iOS PWA는 `a.download`를 무시하는 경우가 많아
 *   길게 눌러 저장할 수 있게 — 캔버스는 길게 눌러도 저장 메뉴가 나오지 않음).
 * 홈·학부모 관리 화면이 같이 쓴다.
 */
export function AcademyParentSignupLink({ academyId }: { academyId: string }) {
  const [copied, setCopied] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const qrWrapRef = useRef<HTMLDivElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const signupUrl = useMemo(() => {
    const path = `/join/parent?academyId=${encodeURIComponent(academyId)}`;
    const origin = getPublicAppOrigin();
    return origin ? `${origin}${path}` : path;
  }, [academyId]);

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const copy = useCallback(async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(signupUrl);
      setCopied(true);
      setMessage(null);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
      return true;
    } catch {
      // 복사할 수 없는 환경 — 링크를 직접 선택해 복사하게 보여 준다
      setCopied(false);
      setShowLink(true);
      setMessage("자동 복사가 되지 않습니다. 아래 링크를 길게 눌러 복사해 주세요.");
      return false;
    }
  }, [signupUrl]);

  const share = useCallback(async () => {
    try {
      await navigator.share({
        title: "학부모 회원 가입",
        text: "학원 학부모 앱 가입 링크입니다.",
        url: signupUrl,
      });
    } catch (e) {
      // 사용자가 공유창을 닫은 것은 오류가 아님
      if (e instanceof DOMException && e.name === "AbortError") return;
      await copy();
    }
  }, [copy, signupUrl]);

  // 숨긴 캔버스가 그려지면 이미지로 바꾼다(기기 안에서만)
  useEffect(() => {
    if (!qrOpen) {
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
      a.download = "학부모-가입-QR.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setMessage("이미지를 저장하지 못했습니다. QR을 길게 눌러 저장하거나 화면을 캡처해 주세요.");
    }
  }, [qrDataUrl]);

  return (
    <div className="glass-card space-y-3 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">학부모 가입 안내</p>
          <p className="break-keep text-[11px] text-neutral-500">
            링크로 가입하면 승인 대기로 들어오고, 학원이 연결하면 자녀가 보입니다.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {canShare ? (
          <button type="button" onClick={() => void share()} className={primaryBtnClass}>
            공유
          </button>
        ) : null}
        <button type="button" onClick={() => void copy()} className={canShare ? btnClass : primaryBtnClass}>
          {copied ? "복사됨" : "링크 복사"}
        </button>
        <button
          type="button"
          onClick={() => setQrOpen((v) => !v)}
          aria-expanded={qrOpen}
          className={btnClass}
        >
          {qrOpen ? "QR 닫기" : "QR 보기"}
        </button>
      </div>
      {message ? (
        <p className="break-keep text-[11px] text-amber-900" role="status">
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
          {/* 이미지로 바꾸는 데만 쓰는 캔버스(화면에는 보이지 않음) */}
          <div ref={qrWrapRef} hidden aria-hidden>
            <QRCodeCanvas value={signupUrl} size={400} marginSize={2} level="M" />
          </div>
          {qrDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- 기기 안에서 만든 data URL(최적화 대상 아님)
            <img src={qrDataUrl} alt="학부모 가입 QR 코드" width={200} height={200} className="h-[200px] w-[200px]" />
          ) : (
            <div className="flex h-[200px] w-[200px] items-center justify-center text-xs text-neutral-400">
              QR 만드는 중…
            </div>
          )}
          <p className="break-keep text-center text-[11px] text-neutral-500">
            휴대폰 카메라로 찍으면 가입 화면이 열립니다.
          </p>
          <p className="break-keep text-center text-[11px] text-neutral-500">
            저장이 안 되면 QR을 길게 눌러 저장해 주세요.
          </p>
          <button type="button" onClick={saveQr} disabled={!qrDataUrl} className={btnClass}>
            이미지 저장
          </button>
        </div>
      ) : null}
    </div>
  );
}
