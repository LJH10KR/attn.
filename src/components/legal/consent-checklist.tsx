"use client";

import { useState } from "react";
import {
  CONSENT_REFUSAL_NOTE,
  CONSENT_SUMMARY_ROWS,
  LEGAL_DOC_PATHS,
  LEGAL_DOC_TITLES,
  type ConsentAudience,
} from "@/lib/legal/legal-docs";

export type ConsentState = { terms: boolean; privacy: boolean };

export const EMPTY_CONSENT: ConsentState = { terms: false, privacy: false };

export function consentComplete(c: ConsentState): boolean {
  return c.terms && c.privacy;
}

export const CONSENT_REQUIRED_MESSAGE = "이용약관과 개인정보 수집·이용에 동의해 주세요.";

/**
 * 가입 동의(2-L) — [전체 동의] + [필수] 이용약관 + [필수] 개인정보 수집·이용(항목·목적·보관 기간 짧은 표) + 문서 링크.
 * 원장·학부모·직원 가입과 원장 다시 동의 시트 공용. 표 내용은 확정본 1차(`CONSENT_SUMMARY_ROWS`, 2-O).
 */
export function ConsentChecklist({
  audience,
  value,
  onChangeAction,
  disabled,
}: {
  audience: ConsentAudience;
  value: ConsentState;
  onChangeAction: (next: ConsentState) => void;
  disabled?: boolean;
}) {
  const [tableOpen, setTableOpen] = useState(false);
  const all = value.terms && value.privacy;
  const rows = CONSENT_SUMMARY_ROWS[audience];

  const docLink = (kind: "terms" | "privacy") => (
    <a
      href={LEGAL_DOC_PATHS[kind]}
      target="_blank"
      rel="noopener noreferrer"
      className="shrink-0 text-[11px] text-[#4a90e2] underline"
    >
      보기
    </a>
  );

  return (
    <div className="space-y-2 rounded-2xl bg-white/50 px-3 py-3 ring-1 ring-neutral-200/80" data-consent-checklist>
      <label className="flex items-center gap-2 text-sm font-medium text-foreground">
        <input
          type="checkbox"
          checked={all}
          disabled={disabled}
          onChange={(e) => onChangeAction({ terms: e.target.checked, privacy: e.target.checked })}
          data-consent-all
        />
        전체 동의
      </label>
      <div className="h-px bg-neutral-200/80" />
      <div className="flex items-center gap-2 text-xs text-neutral-700">
        <label className="flex min-w-0 flex-1 items-center gap-2">
          <input
            type="checkbox"
            checked={value.terms}
            disabled={disabled}
            onChange={(e) => onChangeAction({ ...value, terms: e.target.checked })}
            data-consent-terms
          />
          <span className="break-keep">[필수] {LEGAL_DOC_TITLES.terms} 동의</span>
        </label>
        {docLink("terms")}
      </div>
      <div className="flex items-center gap-2 text-xs text-neutral-700">
        <label className="flex min-w-0 flex-1 items-center gap-2">
          <input
            type="checkbox"
            checked={value.privacy}
            disabled={disabled}
            onChange={(e) => onChangeAction({ ...value, privacy: e.target.checked })}
            data-consent-privacy
          />
          <span className="break-keep">[필수] 개인정보 수집·이용 동의</span>
        </label>
        <button
          type="button"
          onClick={() => setTableOpen((v) => !v)}
          aria-expanded={tableOpen}
          className="shrink-0 text-[11px] text-neutral-500 underline"
        >
          {tableOpen ? "접기" : "내용"}
        </button>
        {docLink("privacy")}
      </div>
      {tableOpen ? (
        <div className="overflow-hidden rounded-xl ring-1 ring-neutral-200">
          <table className="w-full table-fixed text-left text-[11px] text-neutral-600">
            <thead className="bg-neutral-50 text-neutral-500">
              <tr>
                <th className="px-2 py-1.5 font-medium">항목</th>
                <th className="px-2 py-1.5 font-medium">목적</th>
                <th className="w-[26%] px-2 py-1.5 font-medium">보관 기간</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.items} className="border-t border-neutral-100 align-top">
                  <td className="break-keep px-2 py-1.5">{r.items}</td>
                  <td className="break-keep px-2 py-1.5">{r.purpose}</td>
                  <td className="break-keep px-2 py-1.5">{r.retention}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="break-keep border-t border-neutral-100 px-2 py-1.5 text-[10px] text-neutral-400">
            {CONSENT_REFUSAL_NOTE} 자세한 내용은 개인정보 처리방침을 확인해 주세요.
          </p>
        </div>
      ) : null}
    </div>
  );
}
