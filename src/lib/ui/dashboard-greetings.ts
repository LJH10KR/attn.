import { formatKrPhoneDisplay } from "@/lib/phone/kr-phone";

export type MenuProfileContactSource = {
  phone?: string | null;
  email?: string | null;
  googleLinked?: boolean;
  googleEmail?: string | null;
};

export function isProvisionInternalEmail(email: string | null | undefined): boolean {
  const e = email?.trim() ?? "";
  return e.includes("@provision.attndot.internal");
}

/**
 * 프로필 메뉴 연락처 행 — Google 연동 시 이메일·전화번호, 미연동 시 전화번호만(내부 provision 이메일 숨김).
 */
export function menuProfileContactLines(
  profile: MenuProfileContactSource | null | undefined,
): string[] {
  const phone = formatKrPhoneDisplay(profile?.phone);
  const googleEmail =
    profile?.googleLinked === true ? profile?.googleEmail?.trim() || null : null;

  const lines: string[] = [];
  if (googleEmail) {
    lines.push(googleEmail);
  }
  if (phone) {
    lines.push(phone);
  }
  if (lines.length === 0) {
    const email = profile?.email?.trim();
    if (email && !isProvisionInternalEmail(email)) {
      lines.push(email);
    }
  }
  return lines.length > 0 ? lines : ["—"];
}

/** @deprecated 단일 행이 필요할 때 — `menuProfileContactLines` 우선 사용 */
export function menuProfileContactLine(
  profile: MenuProfileContactSource | null | undefined,
): string {
  return menuProfileContactLines(profile).join(" · ");
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
