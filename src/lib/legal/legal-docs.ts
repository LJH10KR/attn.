/**
 * 이용약관·개인정보 처리방침 문서 버전·요약(2-L, 확정본 1차 2-O) — 버전 값은 서버 `functions/src/lib/legal-docs.ts`와 같아야 한다(단위 테스트가 비교).
 * 본문은 `src/content/legal/legal-documents.ts`. 개정 때 두 파일의 버전을 함께 올린다
 * → 원장은 다음 진입 때 다시 동의, 새 가입자는 새 버전으로 기록된다.
 * 시행일은 코드에 두지 않는다 — 관리자 화면 입력값(`appConfig/legalInfo`, `src/lib/legal/legal-info.ts`).
 */
export const LEGAL_DOC_VERSIONS = {
  terms: "2026-11-v1",
  privacy: "2026-11-v1",
} as const;

export type LegalDocKind = keyof typeof LEGAL_DOC_VERSIONS;

export const LEGAL_DOC_PATHS: Record<LegalDocKind, string> = {
  terms: "/terms",
  privacy: "/privacy",
};

export const LEGAL_DOC_TITLES: Record<LegalDocKind, string> = {
  terms: "이용약관",
  privacy: "개인정보 처리방침",
};

/** 가입 요청에 보내는 동의 값 */
export function currentConsentPayload(): { terms: string; privacy: string } {
  return { terms: LEGAL_DOC_VERSIONS.terms, privacy: LEGAL_DOC_VERSIONS.privacy };
}

export type ConsentAudience = "owner" | "parent" | "staff";

/** 가입 화면 "개인정보 수집·이용" 짧은 표 — 확정본 1차 맨 끝 표(`docs/legal/privacy-final-v1.md`) */
export const CONSENT_SUMMARY_ROWS: Record<ConsentAudience, { items: string; purpose: string; retention: string }[]> = {
  owner: [
    { items: "이름, 이메일, 휴대폰 번호, 비밀번호", purpose: "원장 계정 만들기·로그인·학원 운영 서비스 제공", retention: "탈퇴 시까지" },
    { items: "학원 이름", purpose: "학원 관리", retention: "학원 삭제 시까지" },
  ],
  parent: [
    {
      items: "이름, 휴대폰 번호, 로그인 ID·비밀번호(또는 Google 이메일)",
      purpose: "계정 만들기·로그인·자녀 연결·알림",
      retention: "탈퇴 또는 학원의 계정 삭제 시까지",
    },
    {
      items: "휴대폰 번호 확인 기록",
      purpose: "번호 소유 확인·자녀 자동 연결·아이디 찾기·비밀번호 재설정",
      retention: "확인 요청 1일, 확인된 번호는 탈퇴 시까지",
    },
  ],
  staff: [
    {
      items: "이름, 휴대폰 번호, 로그인 ID·비밀번호(또는 Google 이메일)",
      purpose: "직원 계정 만들기·로그인·학원 승인",
      retention: "탈퇴 또는 학원의 계정 삭제 시까지",
    },
    {
      items: "휴대폰 번호 확인 기록",
      purpose: "번호 소유 확인·미리 등록 정보와 맞추기·아이디 찾기·비밀번호 재설정",
      retention: "확인 요청 1일, 확인된 번호는 탈퇴 시까지",
    },
  ],
};

/** 동의 표 아래 공통 문구(확정본) */
export const CONSENT_REFUSAL_NOTE = "동의를 거부할 수 있으나, 거부하면 회원 가입을 할 수 없습니다.";
