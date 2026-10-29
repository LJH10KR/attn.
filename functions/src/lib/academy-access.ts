import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import {
  ACADEMY_PERMISSIONS,
  normalizePermissionList,
  type AcademyPermission,
} from "./permissions";

/**
 * 학원 작업 주체.
 * - owner: 학원 문서 ownerUid — 고정 소유자, 모든 권한
 * - staff: 활성 직원 — 직원 문서 `permissions`(역할에서 서버가 복사)만큼
 * (학원 포털 공용 로그인은 폐지 — 원장·직원 모두 각자 계정)
 */
export type AcademyActor =
  | { kind: "owner"; uid: string; permissions: readonly AcademyPermission[] }
  | {
      kind: "staff";
      uid: string;
      permissions: readonly AcademyPermission[];
      /** 본인에게 배정된 역할 — 자기 역할 수정(권한 자기 상승) 차단에 사용 */
      roleId: string | null;
    };

export function actorHasPermission(
  actor: AcademyActor,
  required: AcademyPermission | readonly AcademyPermission[],
): boolean {
  const list: readonly AcademyPermission[] = typeof required === "string" ? [required] : required;
  return list.some((p) => actor.permissions.includes(p));
}

/** 학원이 없으면 not-found, 학원과 관계없는 계정이면 null */
export async function resolveAcademyActor(
  db: admin.firestore.Firestore,
  academyId: string,
  uid: string,
): Promise<AcademyActor | null> {
  const academySnap = await db.doc(`academies/${academyId}`).get();
  if (!academySnap.exists) {
    throw new HttpsError("not-found", "학원을 찾을 수 없습니다.");
  }
  const ownerUid = academySnap.get("ownerUid");
  if (typeof ownerUid === "string" && ownerUid === uid) {
    return { kind: "owner", uid, permissions: ACADEMY_PERMISSIONS };
  }
  const staffSnap = await db.doc(`academies/${academyId}/staff/${uid}`).get();
  if (staffSnap.exists && staffSnap.get("status") === "active") {
    const roleId = staffSnap.get("roleId");
    return {
      kind: "staff",
      uid,
      permissions: normalizePermissionList(staffSnap.get("permissions")),
      roleId: typeof roleId === "string" && roleId ? roleId : null,
    };
  }
  return null;
}

/**
 * 세부 권한 검사 — `required`가 배열이면 그중 하나만 있어도 통과.
 * 통과하면 작업 주체를 돌려주므로 호출 측에서 기록자(owner/teacher) 판별에 쓸 수 있다.
 * `token`은 지금은 쓰지 않음(포털 클레임 판별 제거) — 서비스 관리자 클레임 등에 대비해 호출 형태 유지.
 */
export async function assertPermission(
  db: admin.firestore.Firestore,
  academyId: string,
  uid: string,
  token: admin.auth.DecodedIdToken,
  required: AcademyPermission | readonly AcademyPermission[],
): Promise<AcademyActor> {
  const actor = await resolveAcademyActor(db, academyId, uid);
  if (!actor || !actorHasPermission(actor, required)) {
    throw new HttpsError("permission-denied", "이 작업을 할 권한이 없습니다.");
  }
  return actor;
}
