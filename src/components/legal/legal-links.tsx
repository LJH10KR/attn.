import Link from "next/link";
import { LEGAL_DOC_PATHS, LEGAL_DOC_TITLES } from "@/lib/legal/legal-docs";

/** 이용약관·개인정보 처리방침 링크 한 줄(2-L) — 로그인·설정 화면 아래 */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <p className={`text-center text-[11px] text-neutral-500 ${className ?? ""}`} data-legal-links>
      <Link href={LEGAL_DOC_PATHS.terms} className="underline-offset-2 hover:underline">
        {LEGAL_DOC_TITLES.terms}
      </Link>
      <span className="mx-2" aria-hidden>
        ·
      </span>
      <Link href={LEGAL_DOC_PATHS.privacy} className="font-medium underline-offset-2 hover:underline">
        {LEGAL_DOC_TITLES.privacy}
      </Link>
    </p>
  );
}
