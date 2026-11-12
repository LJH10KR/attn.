"use client";

import Link from "next/link";
import { Fragment } from "react";
import { LEGAL_DOC_PATHS, LEGAL_DOC_TITLES } from "@/lib/legal/legal-docs";
import { businessInfoItems } from "@/lib/legal/legal-info";
import { useLegalInfo } from "@/lib/legal/use-legal-info";

/**
 * 사이트 공통 하단(2-L, 사업자 정보 2-O) — 이용약관·개인정보 처리방침 링크 + 사업자 정보 한 줄
 * (상호·대표·사업자등록번호·주소·이메일, 빈 값은 뺀다). 로그인·찾기·설정·가입 화면 아래.
 * 항목마다 inline-block — 줄은 항목 사이에서 바뀌고, 한 줄보다 긴 항목(긴 주소 등)만 안에서 줄바꿈 — 390px 가로 밀림 없음.
 */
export function LegalLinks({ className, showBusinessInfo = true }: { className?: string; showBusinessInfo?: boolean }) {
  return (
    <div className={`text-center text-[11px] text-neutral-500 ${className ?? ""}`} data-legal-links>
      <p>
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
      {showBusinessInfo ? <BusinessInfoLine /> : null}
    </div>
  );
}

function BusinessInfoLine() {
  const { info, status } = useLegalInfo();
  const items = businessInfoItems(info);
  return (
    <p
      className="mt-1.5 break-keep text-[10px] leading-relaxed text-neutral-400 [overflow-wrap:anywhere]"
      data-business-info
      data-legal-info-status={status}
    >
      {items.map((it, i) => (
        <Fragment key={it.key}>
          {i > 0 ? <span aria-hidden> · </span> : null}
          <span className="inline-block max-w-full" data-business-info-item={it.key}>
            {it.text}
          </span>
        </Fragment>
      ))}
    </p>
  );
}
