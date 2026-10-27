"use client";

import { useState } from "react";
import { ModalPortal } from "@/components/ui/modal-portal";

export type TempCredentialRow = { displayName: string; loginId: string; tempPassword: string };

type TempCredentialsDialogProps = {
  title: string;
  /** 무엇을 전달해야 하는지 — "이 창을 닫으면 다시 볼 수 없다"는 안내는 아래에 항상 붙음 */
  description: string;
  rows: TempCredentialRow[];
  onConfirmAction: () => void;
};

const btn =
  "rounded-xl border border-neutral-300/70 bg-white/70 px-3 py-2 text-xs font-medium text-foreground disabled:opacity-50";
const primaryBtn =
  "rounded-xl bg-[#222] px-3 py-2 text-xs font-medium text-white disabled:opacity-50";

function rowText(r: TempCredentialRow): string {
  return `${r.displayName}\n로그인 ID: ${r.loginId}\n임시 비밀번호: ${r.tempPassword}`;
}

/**
 * 계정 만들기·임시 비밀번호 재발급·비밀번호 초기화 결과 — 임시 비밀번호는 서버가 저장하지 않으므로 여기서 한 번만 보여 준다.
 * 바깥 클릭·Esc로 닫히지 않음(실수로 닫아 비밀번호를 잃지 않게).
 */
export function TempCredentialsDialog({
  title,
  description,
  rows,
  onConfirmAction,
}: TempCredentialsDialogProps) {
  const [copied, setCopied] = useState<number | "all" | null>(null);

  const copy = (text: string, key: number | "all") => {
    void navigator.clipboard.writeText(text).then(() => setCopied(key));
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[220] flex items-center justify-center bg-black/45 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="temp-credentials-title"
      >
        <div className="flex max-h-[90dvh] w-full max-w-sm flex-col rounded-3xl bg-white p-6 shadow-2xl">
          <h3 id="temp-credentials-title" className="text-base font-semibold text-foreground">
            {title}
          </h3>
          <p className="mt-2 text-xs text-neutral-600">
            {description} 이 창을 닫으면 임시 비밀번호는 다시 볼 수 없습니다.
          </p>
          <ul className="mt-4 min-h-0 space-y-2 overflow-y-auto">
            {rows.map((r, i) => (
              <li
                key={`${r.loginId}-${i}`}
                className="rounded-2xl bg-amber-50 px-4 py-3 text-amber-950 ring-1 ring-amber-200"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">{r.displayName || "(이름 없음)"}</span>
                  {rows.length > 1 ? (
                    <button
                      type="button"
                      className="text-[11px] text-amber-900 underline"
                      onClick={() => copy(rowText(r), i)}
                    >
                      {copied === i ? "복사됨" : "복사"}
                    </button>
                  ) : null}
                </div>
                <dl className="mt-1.5 space-y-1 font-mono text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="font-sans text-xs text-amber-900">로그인 ID</dt>
                    <dd className="break-all text-right">{r.loginId}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="font-sans text-xs text-amber-900">임시 비밀번호</dt>
                    <dd className="break-all text-right">{r.tempPassword}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className={`${btn} flex-1 py-3`}
              onClick={() => copy(rows.map(rowText).join("\n\n"), "all")}
            >
              {copied === "all" ? "복사됨" : rows.length > 1 ? "전체 복사" : "복사"}
            </button>
            <button type="button" className={`${primaryBtn} flex-1 py-3`} onClick={onConfirmAction}>
              확인
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
