/** 하단 탭 홈 슬롯용 로고 — `public/attn_tab_logo.svg` (레거시) */
export const ATTN_TAB_LOGO_SRC = "/attn_tab_logo.svg";

export function AttnTabLogo({ active }: { active: boolean }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- 정적 public 에셋
    <img
      src={ATTN_TAB_LOGO_SRC}
      alt=""
      width={78}
      height={26}
      draggable={false}
      className={`h-[26px] w-[78px] max-h-[26px] max-w-full object-contain object-center ${
        active ? "opacity-100" : "opacity-88"
      }`}
    />
  );
}

/** 하단 탭 홈 슬롯용 홈 아이콘 */
export function HomeTabIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H15v-5h-6v5H4a1 1 0 01-1-1V9.5z"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.6}
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity={active ? 0.14 : 0}
      />
    </svg>
  );
}
