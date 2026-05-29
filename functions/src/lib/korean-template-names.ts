import * as crypto from "node:crypto";

const SURNAMES = [
  "김", "이", "박", "최", "정", "강", "조", "윤", "장", "임",
  "한", "오", "서", "신", "권", "황", "안", "송", "전", "홍",
] as const;

const GIVEN_NAMES_2 = [
  "민준", "서연", "지우", "하은", "도윤", "서준", "예은", "수아", "지호", "유진",
  "현우", "소율", "나은", "다은", "시우", "윤서", "준호", "혜원", "성민", "아린",
  "서아", "하린", "지안", "채원",
] as const;

const GIVEN_NAMES_3 = [
  "민서준", "서현우", "지민호", "하윤서", "도현준", "서아린", "유나연",
] as const;

/** 외자 — 이름 1음절 */
const GIVEN_NAMES_1 = [
  "민", "준", "윤", "건", "진", "혁", "안", "온", "빛", "별",
  "솔", "봄", "율", "린", "서", "우", "재", "영", "화", "석",
] as const;

type NameKind = "three" | "four" | "single";

function pickKind(): NameKind {
  const r = crypto.randomInt(0, 100);
  if (r < 55) return "three";
  if (r < 70) return "four";
  return "single";
}

function pick<T>(arr: readonly T[]): T {
  return arr[crypto.randomInt(0, arr.length)]!;
}

/** 템플릿용 displayName — 호칭·숫자 없음, 최대 10자 */
export function pickTemplateDisplayName(): string {
  const surname = pick(SURNAMES);
  const kind = pickKind();
  let name: string;
  if (kind === "three") {
    name = surname + pick(GIVEN_NAMES_2);
  } else if (kind === "four") {
    name = surname + pick(GIVEN_NAMES_3);
  } else {
    name = surname + pick(GIVEN_NAMES_1);
  }
  if (name.length > 10) {
    return name.slice(0, 10);
  }
  return name;
}

export function pickTemplateDisplayNameUnique(used: Set<string>, maxAttempts = 8): string {
  for (let i = 0; i < maxAttempts; i++) {
    const n = pickTemplateDisplayName();
    if (!used.has(n)) {
      used.add(n);
      return n;
    }
  }
  const fallback = pickTemplateDisplayName();
  used.add(fallback);
  return fallback;
}
