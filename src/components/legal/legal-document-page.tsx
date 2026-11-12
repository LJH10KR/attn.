"use client";

import Link from "next/link";
import { Fragment } from "react";
import { LEGAL_DOCUMENTS } from "@/content/legal/legal-documents";
import { LEGAL_DOC_PATHS, LEGAL_DOC_TITLES, LEGAL_DOC_VERSIONS, type LegalDocKind } from "@/lib/legal/legal-docs";
import {
  formatEffectiveDate,
  legalTokenText,
  splitLegalTokens,
  type LegalInfo,
  type LegalInfoStatus,
} from "@/lib/legal/legal-info";
import { useLegalInfo } from "@/lib/legal/use-legal-info";

const EFFECTIVE_FIELD = { terms: "termsEffectiveDate", privacy: "privacyEffectiveDate" } as const;

/** 문단 하나 — `[[키]]` 토큰을 관리자 입력값으로 채운다(빈 값은 "(준비 중)") */
function LegalText({ text, info, status }: { text: string; info: LegalInfo; status: LegalInfoStatus }) {
  return (
    <>
      {splitLegalTokens(text).map((p, i) =>
        p.kind === "text" ? (
          <Fragment key={i}>{p.text}</Fragment>
        ) : (
          <span key={i} data-legal-token={p.key}>
            {legalTokenText(p.key, info, status)}
          </span>
        ),
      )}
    </>
  );
}

/**
 * 공개 문서 페이지(2-L, 확정본 2-O) — 로그인 없이 보는 화면. 본문은 `src/content/legal/legal-documents.ts`,
 * 대표·사업자 정보·시행일은 `appConfig/legalInfo`(읽기 실패해도 본문은 그대로 보인다).
 * 하단은 다른 문서 링크만 — 사업자 정보는 본문(처리방침 13번·약관 끝)에 있다.
 */
export function LegalDocumentPage({ kind }: { kind: LegalDocKind }) {
  const other: LegalDocKind = kind === "terms" ? "privacy" : "terms";
  const { info, status } = useLegalInfo();
  const effective = status === "loading" ? null : formatEffectiveDate(info[EFFECTIVE_FIELD[kind]]);
  return (
    <main className="min-h-[100dvh] bg-background px-4 py-10">
      <article className="mx-auto w-full max-w-2xl space-y-6" data-legal-doc={kind} data-legal-info-status={status}>
        <header className="space-y-1">
          <p className="text-xs text-neutral-500">attn.</p>
          <h1 className="text-xl font-semibold text-foreground">{LEGAL_DOC_TITLES[kind]}</h1>
          <p className="text-xs text-neutral-500" data-legal-doc-meta>
            문서 버전 {LEGAL_DOC_VERSIONS[kind]} ·{" "}
            {status === "loading" ? "시행일 …" : effective ? `시행일 ${effective}` : "시행일 준비 중"}
          </p>
        </header>
        {LEGAL_DOCUMENTS[kind].map((s, si) => (
          <section key={s.heading ?? `s${si}`} className={s.sub ? "-mt-2 space-y-2" : "space-y-2"}>
            {s.heading ? (
              s.sub ? (
                <h3 className="text-[13px] font-medium text-foreground">{s.heading}</h3>
              ) : (
                <h2 className="text-sm font-semibold text-foreground">{s.heading}</h2>
              )
            ) : null}
            {s.paragraphs.map((p, i) => {
              const nested = p.startsWith("· ");
              return (
                <p
                  key={i}
                  className={`break-keep text-sm leading-relaxed text-neutral-700 [overflow-wrap:anywhere] ${nested ? "pl-3" : ""}`}
                >
                  <LegalText text={p} info={info} status={status} />
                </p>
              );
            })}
          </section>
        ))}
        <footer className="border-t border-neutral-200 pt-4 text-xs text-neutral-500" data-legal-doc-footer>
          <Link href={LEGAL_DOC_PATHS[other]} className="underline">
            {LEGAL_DOC_TITLES[other]}
          </Link>
        </footer>
      </article>
    </main>
  );
}
