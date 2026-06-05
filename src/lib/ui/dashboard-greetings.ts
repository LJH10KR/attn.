import { formatKrPhoneDisplay } from "@/lib/phone/kr-phone";

/** 프로필 메뉴 2행 — 전화번호 우선, 없으면 이메일(내부 provision 주소 등) */
export function menuProfileContactLine(
  profile:
    | { phone?: string | null; email?: string | null }
    | null
    | undefined,
): string {
  const phone = formatKrPhoneDisplay(profile?.phone);
  if (phone) return phone;
  return profile?.email?.trim() || "—";
}

/** 인사말에 쓸 짧은 이름(표시 이름 첫 토큰 또는 이메일 @ 앞) */
export function greetingDisplayNameFromProfile(
  profile: { displayName?: string | null; email?: string | null } | null | undefined,
): string {
  if (!profile) return "회원";
  const d = profile.displayName?.trim();
  if (d) {
    const first = d.split(/\s+/)[0]?.trim();
    if (first) return first;
  }
  const e = profile.email?.trim();
  if (e) {
    const at = e.indexOf("@");
    if (at > 0) return e.slice(0, at);
  }
  return "회원";
}

/** 괄호 안에 넣을 학원 표기 — 이름 우선, 없으면 ID */
export function academyLabelForGreeting(
  academyName?: string | null,
  academyId?: string | null,
): string {
  const n = academyName?.trim();
  const id = academyId?.trim();
  return n || id || "학원";
}
