"use client";

import { useState } from "react";

type Props = {
  open: boolean;
  /** Next.js 클라이언트 컴포넌트 직렬화 린트: `*Action` 접미사 필요 */
  onCloseAction: () => void;
  /** 완료 시 true면 Firestore 등에 `attn_hide_ios_pwa_hint` 저장 */
  onConfirmAction: (dontShowAgain: boolean) => void | Promise<void>;
};

export function IosPwaHintModal({ open, onCloseAction, onConfirmAction }: Props) {
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 px-4 py-8">
      <div
        className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-[1.75rem] border border-white/70 bg-[rgba(252,251,248,0.98)] p-6 shadow-[0_24px_80px_-20px_rgba(0,0,0,0.25)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ios-pwa-hint-title"
      >
        <h2 id="ios-pwa-hint-title" className="text-base font-semibold text-foreground">
          iOS에서 알림을 받으려면
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-700 whitespace-pre-line">
          {`푸시 알림을 받으려면 Safari에서 이 페이지를 홈 화면에 추가해 주세요.

1) 화면 하단의 공유 버튼(□와 ↑ 아이콘)을 누릅니다
   → [공유]

2) 메뉴를 아래로 내려 [홈 화면에 추가]를 선택합니다
   → [홈 화면에 추가]

3) 오른쪽 위 [추가]를 누르면 설치가 완료됩니다
   → [추가]

이후 홈 화면의 아이콘으로 attn.을 열면 알림을 받기 쉽습니다.`}
        </p>
        <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-neutral-800">
          <input
            type="checkbox"
            className="mt-1 rounded border-neutral-400"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
          />
          <span>다시 보지 않기</span>
        </label>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => {
              setDontShowAgain(false);
              onCloseAction();
            }}
            disabled={busy}
            className="rounded-2xl border border-neutral-300/80 bg-white/80 px-4 py-2.5 text-sm font-medium text-neutral-800 hover:bg-white disabled:opacity-50"
          >
            닫기
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void (async () => {
                setBusy(true);
                try {
                  await Promise.resolve(onConfirmAction(dontShowAgain));
                  setDontShowAgain(false);
                  onCloseAction();
                } finally {
                  setBusy(false);
                }
              })();
            }}
            className="rounded-2xl bg-[#222] dark:bg-neutral-100 px-4 py-2.5 text-sm font-medium text-white dark:text-neutral-950 hover:bg-[#333] dark:hover:bg-white disabled:opacity-50"
          >
            {busy ? "처리 중…" : "확인"}
          </button>
        </div>
      </div>
    </div>
  );
}
