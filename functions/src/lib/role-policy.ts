import type { AcademyActor } from "./academy-access";
import type { AcademyPermission } from "./permissions";

/**
 * 역할 수정·삭제·배정과 직원 계정 변경의 권한 상승 차단 규칙 — Firestore 없이 판단하는 순수 함수(`test/role-policy.test.mjs`).
 * 원장은 제한 없음. 직원(settings.members)은
 * - 본인에게 배정된 역할을 고치거나 본인 역할을 바꿀 수 없고
 * - 본인이 가진 권한을 넘는 역할을 만들거나 고치거나 배정할 수 없으며
 * - 본인보다 넓은 권한을 가진 역할·직원은 건드릴 수 없다(상위 관리자 강등 방지).
 * 위반이면 사용자에게 보여 줄 문구, 통과면 null.
 */

type PolicyActor =
  | Pick<Extract<AcademyActor, { kind: "owner" }>, "kind">
  | Pick<Extract<AcademyActor, { kind: "staff" }>, "kind" | "uid" | "permissions" | "roleId">;

function isSubset(
  list: readonly AcademyPermission[],
  allowed: readonly AcademyPermission[],
): boolean {
  return list.every((p) => allowed.includes(p));
}

const MSG_OWN_ROLE = "본인에게 배정된 권한은 바꿀 수 없습니다.";
const MSG_WIDER_ROLE = "본인보다 넓은 권한은 수정하거나 삭제할 수 없습니다.";
const MSG_GRANT_LIMIT = "본인이 가진 권한까지만 부여할 수 있습니다.";

/** 역할 생성(roleId·currentPermissions 없음) 또는 수정 */
export function roleSaveViolation(
  actor: PolicyActor,
  target: {
    roleId: string | null;
    currentPermissions: readonly AcademyPermission[] | null;
    nextPermissions: readonly AcademyPermission[];
  },
): string | null {
  if (actor.kind !== "staff") return null;
  if (target.roleId && target.roleId === actor.roleId) return MSG_OWN_ROLE;
  if (target.currentPermissions && !isSubset(target.currentPermissions, actor.permissions)) {
    return MSG_WIDER_ROLE;
  }
  if (!isSubset(target.nextPermissions, actor.permissions)) return MSG_GRANT_LIMIT;
  return null;
}

export function roleDeleteViolation(
  actor: PolicyActor,
  target: { roleId: string; currentPermissions: readonly AcademyPermission[] },
): string | null {
  if (actor.kind !== "staff") return null;
  if (target.roleId === actor.roleId) return MSG_OWN_ROLE;
  if (!isSubset(target.currentPermissions, actor.permissions)) return MSG_WIDER_ROLE;
  return null;
}

/**
 * 다른 직원의 계정에 영향을 주는 작업(활성·비활성·삭제·임시 비밀번호·퇴사 처리) —
 * 직원은 본인 계정과 본인보다 넓은 권한의 직원 계정을 건드릴 수 없다(계정 탈취·상위 관리자 차단 방지).
 */
export function staffAccountChangeViolation(
  actor: PolicyActor,
  target: { staffId: string; staffCurrentPermissions: readonly AcademyPermission[] },
): string | null {
  if (actor.kind !== "staff") return null;
  if (target.staffId === actor.uid) return "본인 계정은 직접 바꿀 수 없습니다.";
  if (!isSubset(target.staffCurrentPermissions, actor.permissions)) {
    return "본인보다 넓은 권한을 가진 직원의 계정은 바꿀 수 없습니다.";
  }
  return null;
}

export function roleAssignViolation(
  actor: PolicyActor,
  target: {
    staffId: string;
    staffCurrentPermissions: readonly AcademyPermission[];
    rolePermissions: readonly AcademyPermission[];
  },
): string | null {
  if (actor.kind !== "staff") return null;
  if (target.staffId === actor.uid) return "본인의 권한은 바꿀 수 없습니다.";
  if (!isSubset(target.staffCurrentPermissions, actor.permissions)) {
    return "본인보다 넓은 권한을 가진 직원의 권한은 바꿀 수 없습니다.";
  }
  if (!isSubset(target.rolePermissions, actor.permissions)) return MSG_GRANT_LIMIT;
  return null;
}
