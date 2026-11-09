import Link from "next/link";
import { LEGAL_DOCUMENTS } from "@/content/legal/legal-documents";
import {
  LEGAL_DOC_EFFECTIVE_DATES,
  LEGAL_DOC_PATHS,
  LEGAL_DOC_TITLES,
  LEGAL_DOC_VERSIONS,
  type LegalDocKind,
} from "@/lib/legal/legal-docs";

/** 공개 문서 페이지(2-L) — 로그인 없이 보는 정적 화면. 본문은 `src/content/legal/legal-documents.ts` */
export function LegalDocumentPage({ kind }: { kind: LegalDocKind }) {
  const other: LegalDocKind = kind === "terms" ? "privacy" : "terms";
  const effective = LEGAL_DOC_EFFECTIVE_DATES[kind];
  return (
    <main className="min-h-[100dvh] bg-background px-4 py-10">
      <article className="mx-auto w-full max-w-2xl space-y-6" data-legal-doc={kind}>
        <header className="space-y-1">
          <p className="text-xs text-neutral-500">attn.</p>
          <h1 className="text-xl font-semibold text-foreground">{LEGAL_DOC_TITLES[kind]}</h1>
          <p className="text-xs text-neutral-500">
            문서 버전 {LEGAL_DOC_VERSIONS[kind]} · {effective ? `시행일 ${effective}` : "확정 전 초안"}
          </p>
        </header>
        {LEGAL_DOCUMENTS[kind].map((s) => (
          <section key={s.heading} className="space-y-2">
            <h2 className="text-sm font-semibold text-foreground">{s.heading}</h2>
            {s.paragraphs.map((p, i) => (
              <p key={i} className="break-keep text-sm leading-relaxed text-neutral-700">
                {p}
              </p>
            ))}
          </section>
        ))}
        <footer className="border-t border-neutral-200 pt-4 text-xs text-neutral-500">
          <Link href={LEGAL_DOC_PATHS[other]} className="underline">
            {LEGAL_DOC_TITLES[other]}
          </Link>
        </footer>
      </article>
    </main>
  );
}
