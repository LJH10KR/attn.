/**
 * 이용약관·개인정보 처리방침 문서 버전·요약(2-L) — 버전 값은 서버 `functions/src/lib/legal-docs.ts`와 같아야 한다(단위 테스트가 비교).
 * 본문은 `src/content/legal/*`(기획 초안 → 사용자 확정본으로 교체). 확정·개정 때 두 파일의 버전을 함께 올린다
 * → 원장은 다음 진입 때 다시 동의, 새 가입자는 새 버전으로 기록된다.
 */
export const LEGAL_DOC_VERSIONS = {
  terms: "2026-11-draft",
  privacy: "2026-11-draft",
} as const;

export type LegalDocKind = keyof typeof LEGAL_DOC_VERSIONS;

/** 시행일 — 확정 전엔 null(페이지에 "확정 전 초안"으로 표시) */
export const LEGAL_DOC_EFFECTIVE_DATES: Record<LegalDocKind, string | null> = {
  terms: null,
  privacy: null,
};

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

/** 가입 화면 "개인정보 수집·이용" 짧은 표 — **자리 표시(사용자 확정 전)**. 확정본이 오면 이 값만 바꾼다 */
export const CONSENT_SUMMARY_ROWS: Record<ConsentAudience, { items: string; purpose: string; retention: string }[]> = {
  owner: [
    { items: "이름, 이메일, 휴대폰 번호, 비밀번호", purpose: "원장 계정 만들기·로그인·학원 운영 서비스 제공", retention: "탈퇴 시까지(확정 전)" },
    { items: "학원 정보(이름·사업자 정보)", purpose: "학원 관리·수납 영수증", retention: "탈퇴 시까지(확정 전)" },
  ],
  parent: [
    { items: "이름, 휴대폰 번호, 로그인 ID, 비밀번호(또는 Google 이메일)", purpose: "학부모 계정 만들기·로그인·자녀 연결", retention: "탈퇴 시까지(확정 전)" },
    { items: "휴대폰 번호 확인 기록", purpose: "번호 소유 확인(자녀 자동 연결)", retention: "확정 전" },
    { items: "푸시 알림 토큰", purpose: "출결·수납 알림", retention: "알림 끄기·탈퇴 시까지(확정 전)" },
  ],
  staff: [
    { items: "이름, 휴대폰 번호, 로그인 ID, 비밀번호(또는 Google 이메일)", purpose: "직원 계정 만들기·로그인·업무 권한", retention: "퇴사·계정 삭제 시까지(확정 전)" },
    { items: "휴대폰 번호 확인 기록", purpose: "번호 소유 확인(미리 등록한 직원 확인)", retention: "확정 전" },
  ],
};
