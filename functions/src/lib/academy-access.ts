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
 * - portal: 학원 포털 공용 로그인(custom token role=academy) — 폐지 전까지 모든 권한
 * - staff: 활성 직원 — 멤버 문서 `permissions`(역할에서 서버가 복사)만큼
 */
export type AcademyActor =
  | { kind: "owner"; uid: string; permissions: readonly AcademyPermission[] }
  | { kind: "portal"; uid: string; permissions: readonly AcademyPermission[] }
  | { kind: "staff"; uid: string; permissions: readonly AcademyPermission[] };

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
  token: admin.auth.DecodedIdToken,
): Promise<AcademyActor | null> {
  const academySnap = await db.doc(`academies/${academyId}`).get();
  if (!academySnap.exists) {
    throw new HttpsError("not-found", "학원을 찾을 수 없습니다.");
  }
  const ownerUid = academySnap.get("ownerUid");
  if (typeof ownerUid === "string" && ownerUid === uid) {
    return { kind: "owner", uid, permissions: ACADEMY_PERMISSIONS };
  }
  if (token.role === "academy" && token.academyId === academyId) {
    return { kind: "portal", uid, permissions: ACADEMY_PERMISSIONS };
  }
  const staffSnap = await db.doc(`academies/${academyId}/teachers/${uid}`).get();
  if (staffSnap.exists && staffSnap.get("status") === "active") {
    return {
      kind: "staff",
      uid,
      permissions: normalizePermissionList(staffSnap.get("permissions")),
    };
  }
  return null;
}

/**
 * 세부 권한 검사 — `required`가 배열이면 그중 하나만 있어도 통과.
 * 통과하면 작업 주체를 돌려주므로 호출 측에서 기록자(owner/academy/teacher) 판별에 쓸 수 있다.
 */
export async function assertPermission(
  db: admin.firestore.Firestore,
  academyId: string,
  uid: string,
  token: admin.auth.DecodedIdToken,
  required: AcademyPermission | readonly AcademyPermission[],
): Promise<AcademyActor> {
  const actor = await resolveAcademyActor(db, academyId, uid, token);
  if (!actor || !actorHasPermission(actor, required)) {
    throw new HttpsError("permission-denied", "이 작업을 할 권한이 없습니다.");
  }
  return actor;
}
