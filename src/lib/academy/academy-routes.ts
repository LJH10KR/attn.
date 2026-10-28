import {
  ACADEMY_PERMISSION_GROUPS,
  type AcademyNavTab,
  type AcademyPermission,
} from "@/lib/academy/permissions";

/**
 * 학원 화면 주소 — `/academy/[academyId]/{탭}/{상세}`.
 * 상세 경로는 세부 권한 키와 같은 이름(`billing.collections` → `billing/collections`,
 * `lessons.notificationLog` → `lessons/notification-log`).
 * 주소를 만들 때는 항상 `academyPath`를 거쳐 학원 ID가 경로에 유지되게 한다(학원 전환 시 ID만 바꿈).
 */
export type AcademyTab = "home" | AcademyNavTab;

/** 하단 탭 라벨(두 글자) — 화면 제목은 `ACADEMY_PERMISSION_GROUPS`의 전체 이름 */
export const ACADEMY_TAB_SHORT_LABELS: Record<AcademyTab, string> = {
  home: "홈",
  operations: "운영",
  billing: "수납",
  lessons: "수업",
  settings: "설정",
};

/** 화면이 아니라 버튼 권한이라 상세 경로가 없는 키 */
const ROUTELESS_PERMISSIONS: readonly AcademyPermission[] = ["billing.refunds"];

/** 아직 화면이 없어 "준비 중"으로 보여 주는 메뉴 */
const NOT_READY_PERMISSIONS: readonly AcademyPermission[] = [
  "operations.classes",
  "billing.invoices",
  "billing.collections",
  "lessons.attendance",
  "lessons.notices",
];

export type AcademyMenu = {
  permission: AcademyPermission;
  label: string;
  /** 학원 경로 아래 상대 경로 — `academyPath(id, sub)` */
  sub: string;
  ready: boolean;
};

export type AcademyTabMenus = {
  tab: AcademyNavTab;
  /** 화면 제목(운영관리 등) */
  title: string;
  menus: AcademyMenu[];
};

function permissionSubPath(key: AcademyPermission): string {
  return key.replace(".", "/").replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

export const ACADEMY_TAB_MENUS: AcademyTabMenus[] = ACADEMY_PERMISSION_GROUPS.map((g) => ({
  tab: g.tab,
  title: g.label,
  menus: g.permissions
    .filter((p) => !ROUTELESS_PERMISSIONS.includes(p.key))
    .map((p) => ({
      permission: p.key,
      label: p.label,
      sub: permissionSubPath(p.key),
      ready: !NOT_READY_PERMISSIONS.includes(p.key),
    })),
}));

export function academyTabMenus(tab: AcademyNavTab): AcademyTabMenus {
  return ACADEMY_TAB_MENUS.find((t) => t.tab === tab)!;
}

export function academyMenu(permission: AcademyPermission): AcademyMenu | null {
  for (const t of ACADEMY_TAB_MENUS) {
    const m = t.menus.find((x) => x.permission === permission);
    if (m) return m;
  }
  return null;
}

/** `/academy/{id}` 또는 `/academy/{id}/{sub}` */
export function academyPath(academyId: string, sub = ""): string {
  const base = `/academy/${encodeURIComponent(academyId)}`;
  return sub ? `${base}/${sub}` : base;
}

/** 권한 키에 해당하는 상세 화면 주소(`settings.staff` → `/academy/{id}/settings/staff`) */
export function academyMenuPath(academyId: string, permission: AcademyPermission): string {
  return academyPath(academyId, academyMenu(permission)?.sub ?? "");
}

export type AcademyRouteInfo = {
  academyId: string;
  tab: AcademyTab;
  /** 화면 제목 — 홈은 null */
  title: string | null;
  /** 이 중 하나라도 있어야 볼 수 있음 — 홈은 null(학원 멤버면 누구나) */
  required: readonly AcademyPermission[] | null;
  /** 뒤로가기 대상(상세 → 탭 요약) — 홈·탭 요약은 null */
  backSub: string | null;
};

/** 주소에서 학원 화면 정보 — 학원 경로가 아니거나 모르는 화면이면 null */
export function resolveAcademyRoute(pathname: string): AcademyRouteInfo | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "academy" || parts.length < 2) return null;
  const academyId = decodeURIComponent(parts[1]);
  const rest = parts.slice(2);
  if (rest.length === 0) {
    return { academyId, tab: "home", title: null, required: null, backSub: null };
  }
  const tabMenus = ACADEMY_TAB_MENUS.find((t) => t.tab === rest[0]);
  if (!tabMenus) return null;
  if (rest.length === 1) {
    return {
      academyId,
      tab: tabMenus.tab,
      title: tabMenus.title,
      required: tabMenus.menus.map((m) => m.permission),
      backSub: null,
    };
  }
  const sub = rest.slice(0, 2).join("/");
  const menu = tabMenus.menus.find((m) => m.sub === sub);
  if (!menu) return null;
  return {
    academyId,
    tab: tabMenus.tab,
    title: menu.label,
    required: [menu.permission],
    backSub: tabMenus.tab,
  };
}
