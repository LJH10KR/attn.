/**
 * 학원 세부 권한 — 하단 5탭 내비의 상세 메뉴 단위 키.
 *
 * `functions/src/lib/permissions.ts`(서버)와 `firestore.rules`(문자열 리터럴)가 같은 키를 쓰므로
 * 키를 추가·변경할 때는 세 곳을 함께 맞출 것.
 */
export const ACADEMY_PERMISSIONS = [
  "operations.classes",
  "operations.parents",
  "operations.students",
  "billing.invoices",
  "billing.collections",
  "billing.payments",
  "lessons.attendance",
  "lessons.notices",
  "lessons.notificationLog",
  "settings.staff",
  "settings.members",
  "settings.general",
] as const;

export type AcademyPermission = (typeof ACADEMY_PERMISSIONS)[number];

export function isAcademyPermission(raw: unknown): raw is AcademyPermission {
  return typeof raw === "string" && (ACADEMY_PERMISSIONS as readonly string[]).includes(raw);
}

/** 중복·알 수 없는 키 제거 후 정의 순서로 정렬 */
export function normalizePermissionList(raw: unknown): AcademyPermission[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set(raw.filter(isAcademyPermission));
  return ACADEMY_PERMISSIONS.filter((p) => set.has(p));
}

/** 하단 탭(홈 제외) — 권한이 하나도 없는 탭은 하단 바에서 숨김 */
export type AcademyNavTab = "operations" | "billing" | "lessons" | "settings";

export const ACADEMY_PERMISSION_GROUPS: {
  tab: AcademyNavTab;
  label: string;
  permissions: { key: AcademyPermission; label: string }[];
}[] = [
  {
    tab: "operations",
    label: "운영관리",
    permissions: [
      { key: "operations.classes", label: "반 관리" },
      { key: "operations.parents", label: "학부모 관리" },
      { key: "operations.students", label: "원생 관리" },
    ],
  },
  {
    tab: "billing",
    label: "수납관리",
    permissions: [
      { key: "billing.invoices", label: "청구서 관리" },
      { key: "billing.collections", label: "수납/미납" },
      { key: "billing.payments", label: "결제 내역" },
    ],
  },
  {
    tab: "lessons",
    label: "수업관리",
    permissions: [
      { key: "lessons.attendance", label: "출결관리" },
      { key: "lessons.notices", label: "공지" },
      { key: "lessons.notificationLog", label: "알림 기록" },
    ],
  },
  {
    tab: "settings",
    label: "설정",
    permissions: [
      { key: "settings.staff", label: "직원 관리" },
      { key: "settings.members", label: "멤버 초대/권한 관리" },
      { key: "settings.general", label: "전체설정" },
    ],
  },
];

export const ACADEMY_PERMISSION_LABELS: Record<AcademyPermission, string> = Object.fromEntries(
  ACADEMY_PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => [p.key, p.label])),
) as Record<AcademyPermission, string>;

export const ROLE_TEMPLATE_KEYS = [
  "superAdmin",
  "admin",
  "office",
  "lessonManager",
  "teacher",
] as const;

export type RoleTemplateKey = (typeof ROLE_TEMPLATE_KEYS)[number];
