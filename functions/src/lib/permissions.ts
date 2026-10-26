/**
 * 학원 세부 권한 — 하단 5탭 내비의 상세 메뉴 단위 키.
 *
 * `src/lib/academy/permissions.ts`(화면)와 `firestore.rules`(문자열 리터럴)가 같은 키를 쓰므로
 * 키를 추가·변경할 때는 세 곳을 함께 맞출 것.
 *
 * 원장(학원 문서 ownerUid)은 고정 소유자로 모든 권한을 가진다. 직원은 멤버 문서의
 * `permissions` 배열(역할에서 서버가 복사)로 판별하며, 권한이 하나도 없으면 "내 반" 화면만 쓴다.
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

export const ROLE_TEMPLATE_KEYS = [
  "superAdmin",
  "admin",
  "office",
  "lessonManager",
  "teacher",
] as const;

export type RoleTemplateKey = (typeof ROLE_TEMPLATE_KEYS)[number];

export function isRoleTemplateKey(raw: unknown): raw is RoleTemplateKey {
  return typeof raw === "string" && (ROLE_TEMPLATE_KEYS as readonly string[]).includes(raw);
}

/** 새 직원 계정의 기본 역할 — 권한 없음("내 반"만) */
export const DEFAULT_STAFF_ROLE_ID: RoleTemplateKey = "teacher";

/** 템플릿 역할 — 문서 ID = 템플릿 키. 이름·권한은 학원이 수정 가능, 삭제는 불가. */
export const ROLE_TEMPLATES: Record<
  RoleTemplateKey,
  { name: string; permissions: readonly AcademyPermission[] }
> = {
  superAdmin: {
    name: "슈퍼관리자",
    permissions: ACADEMY_PERMISSIONS,
  },
  admin: {
    name: "관리자",
    permissions: ACADEMY_PERMISSIONS.filter((p) => p !== "settings.members"),
  },
  office: {
    name: "행정담당",
    permissions: [
      "operations.classes",
      "operations.parents",
      "operations.students",
      "billing.invoices",
      "billing.collections",
      "billing.payments",
      "lessons.notices",
    ],
  },
  lessonManager: {
    name: "수업관리",
    permissions: [
      "operations.classes",
      "operations.students",
      "lessons.attendance",
      "lessons.notices",
      "lessons.notificationLog",
    ],
  },
  teacher: {
    name: "선생님",
    permissions: [],
  },
};
