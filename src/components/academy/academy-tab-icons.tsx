import { HomeTabIcon } from "@/components/dashboard/attn-tab-logo";
import type { AcademyTab } from "@/lib/academy/academy-routes";

function strokeColor(active: boolean): string {
  return active ? "#171717" : "#666";
}

function IconOperations({ active }: { active: boolean }) {
  const stroke = strokeColor(active);
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="9" cy="8" r="3" stroke={stroke} strokeWidth="1.6" />
      <path d="M3 19c.7-2.7 2.6-4.5 6-4.5s5.3 1.8 6 4.5" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="17" cy="8" r="2.2" stroke={stroke} strokeWidth="1.4" />
      <path d="M20 19c-.4-1.8-1.5-3-3-3.5" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconBilling({ active }: { active: boolean }) {
  const stroke = strokeColor(active);
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" stroke={stroke} strokeWidth="1.6" />
      <path d="M3 10h18" stroke={stroke} strokeWidth="1.6" />
      <path d="M7 15h4" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconLessons({ active }: { active: boolean }) {
  const stroke = strokeColor(active);
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 4L2 9l10 5 10-5-10-5z"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill={active ? "rgba(0,0,0,0.06)" : "none"}
      />
      <path d="M6 11.5V17c0 1.657 2.686 3 6 3s6-1.343 6-3v-5.5" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M20 9v4" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconSettings({ active }: { active: boolean }) {
  const stroke = strokeColor(active);
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3" stroke={stroke} strokeWidth="1.6" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        stroke={stroke}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 학원 하단 5탭 아이콘 */
export function AcademyTabIcon({ tab, active }: { tab: AcademyTab; active: boolean }) {
  switch (tab) {
    case "home":
      return <HomeTabIcon active={active} />;
    case "operations":
      return <IconOperations active={active} />;
    case "billing":
      return <IconBilling active={active} />;
    case "lessons":
      return <IconLessons active={active} />;
    case "settings":
      return <IconSettings active={active} />;
  }
}
