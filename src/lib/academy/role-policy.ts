import type { AcademyPermission } from "@/lib/academy/permissions";

/**
 * 화면용 권한 상승 차단 판단 — 서버 `functions/src/lib/role-policy.ts`와 같은 원칙으로 버튼·선택지만 숨긴다.
 * 실제 차단은 서버가 하므로 여기서 틀려도 권한이 생기지는 않는다.
 * 원장은 제한 없음. 직원은 본인·본인보다 넓은 권한의 역할·직원 계정을 건드릴 수 없고, 본인 권한까지만 부여한다.
 */
export type PermissionViewer = {
  actor: "owner" | "staff";
  uid: string;
  /** 본인에게 배정된 역할(원장은 null) */
  roleId: string | null;
  permissions: ReadonlySet<AcademyPermission>;
};

/** 목록의 권한이 모두 보는 사람 권한 안에 있는지(원장은 항상 참) */
export function withinViewerPermissions(
  viewer: PermissionViewer,
  list: readonly AcademyPermission[],
): boolean {
  return viewer.actor === "owner" || list.every((p) => viewer.permissions.has(p));
}

/** 다른 직원 계정 변경(승인·비활성·삭제·비밀번호·역할 바꾸기) — 대상이 본인이 아니고 권한 범위 안 */
export function canChangeStaffAccount(
  viewer: PermissionViewer,
  target: { id: string; permissions: readonly AcademyPermission[] },
): boolean {
  if (viewer.actor === "owner") return true;
  return target.id !== viewer.uid && withinViewerPermissions(viewer, target.permissions);
}

/** 역할 수정·삭제 — 본인 역할이 아니고 권한 범위 안 */
export function canEditRole(
  viewer: PermissionViewer,
  role: { id: string; permissions: readonly AcademyPermission[] },
): boolean {
  if (viewer.actor === "owner") return true;
  return role.id !== viewer.roleId && withinViewerPermissions(viewer, role.permissions);
}
