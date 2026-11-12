import type { LegalDocKind } from "@/lib/legal/legal-docs";

/**
 * 이용약관·개인정보 처리방침 본문(2-L) — **자리 표시**. 기획이 초안을 쓰고 사용자가 확정하면 이 파일의 섹션만 바꾸고
 * `src/lib/legal/legal-docs.ts`(+ 서버 `functions/src/lib/legal-docs.ts`)의 버전·시행일을 올린다.
 * 섹션 = 제목 + 문단 목록(문단 안 줄바꿈 없음, 목록이 필요하면 문단을 나눔).
 */
export type LegalSection = { heading: string; paragraphs: string[] };

const PLACEHOLDER = "확정본으로 교체 예정입니다.";

export const LEGAL_DOCUMENTS: Record<LegalDocKind, LegalSection[]> = {
  terms: [
    { heading: "제1조 목적", paragraphs: [PLACEHOLDER] },
    { heading: "제2조 정의", paragraphs: [PLACEHOLDER] },
    { heading: "제3조 약관의 효력과 변경", paragraphs: [PLACEHOLDER] },
    { heading: "제4조 회원 가입·계정", paragraphs: [PLACEHOLDER] },
    { heading: "제5조 서비스 이용", paragraphs: [PLACEHOLDER] },
    { heading: "제6조 회원 탈퇴·이용 제한", paragraphs: [PLACEHOLDER] },
    { heading: "제7조 책임의 한계", paragraphs: [PLACEHOLDER] },
    { heading: "부칙", paragraphs: [PLACEHOLDER] },
  ],
  privacy: [
    { heading: "1. 처리하는 개인정보 항목", paragraphs: [PLACEHOLDER] },
    { heading: "2. 처리 목적", paragraphs: [PLACEHOLDER] },
    { heading: "3. 보유·이용 기간", paragraphs: [PLACEHOLDER] },
    {
      heading: "4. 처리 위탁",
      paragraphs: [
        "휴대폰 번호 확인: OCTOMO(주식회사 옥토버스)",
        PLACEHOLDER,
      ],
    },
    { heading: "5. 국외 이전", paragraphs: [PLACEHOLDER] },
    { heading: "6. 정보주체의 권리와 행사 방법", paragraphs: [PLACEHOLDER] },
    { heading: "7. 파기 절차·방법", paragraphs: [PLACEHOLDER] },
    { heading: "8. 안전성 확보 조치", paragraphs: [PLACEHOLDER] },
    { heading: "9. 개인정보 보호책임자", paragraphs: [PLACEHOLDER] },
    { heading: "10. 처리방침의 변경", paragraphs: [PLACEHOLDER] },
  ],
};
