/** 하단 탭 홈 슬롯용 로고 — `public/attn_tab_logo.svg` */
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
