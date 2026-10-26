import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { assertPermission } from "./lib/academy-access";
import { chunkArray } from "./lib/firestore-cleanup";
import { roleAssignViolation, roleDeleteViolation, roleSaveViolation } from "./lib/role-policy";
import {
  isAcademyPermission,
  isRoleTemplateKey,
  normalizePermissionList,
  ROLE_TEMPLATE_KEYS,
  ROLE_TEMPLATES,
} from "./lib/permissions";

/**
 * 학원 역할 — `academies/{academyId}/roles/{roleId}`. 템플릿 역할은 문서 ID = 템플릿 키.
 * 직원 문서(`staff/{uid}`)에 `roleId`와 함께 `permissions`를 복사해 두어
 * 보안 규칙이 문서 하나만 읽고 판별하도록 한다(역할을 고치면 여기서 다시 복사).
 */

const MAX_ROLES_PER_ACADEMY = 30;
const MAX_ROLE_NAME_LENGTH = 30;

function rolesCol(db: admin.firestore.Firestore, academyId: string) {
  return db.collection(`academies/${academyId}/roles`);
}

function staffCol(db: admin.firestore.Firestore, academyId: string) {
  return db.collection(`academies/${academyId}/staff`);
}

function requireString(raw: unknown, message: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.includes("/")) {
    throw new HttpsError("invalid-argument", message);
  }
  return s;
}

function parseRoleName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > MAX_ROLE_NAME_LENGTH) {
    throw new HttpsError("invalid-argument", `권한 이름을 1~${MAX_ROLE_NAME_LENGTH}자로 입력해 주세요.`);
  }
  return name;
}

function parsePermissions(raw: unknown) {
  if (!Array.isArray(raw) || raw.some((p) => !isAcademyPermission(p))) {
    throw new HttpsError("invalid-argument", "권한 목록이 올바르지 않습니다.");
  }
  return normalizePermissionList(raw);
}

/** 없는 템플릿 역할만 만든다 — 학원 생성 시·역할 목록 조회 시 호출 */
export async function ensureAcademyRoleTemplates(
  db: admin.firestore.Firestore,
  academyId: string,
): Promise<void> {
  const col = rolesCol(db, academyId);
  const snaps = await db.getAll(...ROLE_TEMPLATE_KEYS.map((k) => col.doc(k)));
  const batch = db.batch();
  let missing = 0;
  snaps.forEach((snap, i) => {
    if (snap.exists) return;
    const key = ROLE_TEMPLATE_KEYS[i]!;
    batch.set(snap.ref, {
      name: ROLE_TEMPLATES[key].name,
      permissions: [...ROLE_TEMPLATES[key].permissions],
      template: key,
      sortOrder: i,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    missing += 1;
  });
  if (missing > 0) {
    await batch.commit();
  }
}

/** 역할을 쓰는 직원 멤버 문서에 권한을 다시 복사 */
async function syncRolePermissionsToStaff(
  db: admin.firestore.Firestore,
  academyId: string,
  roleId: string,
  permissions: string[],
): Promise<void> {
  const snap = await staffCol(db, academyId).where("roleId", "==", roleId).get();
  for (const chunk of chunkArray(snap.docs, 400)) {
    const batch = db.batch();
    for (const d of chunk) {
      batch.update(d.ref, { permissions, updatedAt: FieldValue.serverTimestamp() });
    }
    await batch.commit();
  }
}

/** 설정 › 멤버 초대/권한 관리 — 역할 목록(템플릿 보장) + 역할별 직원 수 */
export const listAcademyRoles = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireString(request.data?.academyId, "학원 ID가 필요합니다.");
  const db = admin.firestore();
  await assertPermission(db, academyId, request.auth.uid, request.auth.token, "settings.members");

  await ensureAcademyRoleTemplates(db, academyId);
  const [rolesSnap, staffSnap] = await Promise.all([
    rolesCol(db, academyId).get(),
    staffCol(db, academyId).get(),
  ]);
  const memberCount = new Map<string, number>();
  for (const d of staffSnap.docs) {
    const roleId = d.get("roleId");
    if (typeof roleId === "string") {
      memberCount.set(roleId, (memberCount.get(roleId) ?? 0) + 1);
    }
  }

  const roles = rolesSnap.docs
    .map((d) => {
      const template = d.get("template");
      return {
        id: d.id,
        name: typeof d.get("name") === "string" ? (d.get("name") as string) : d.id,
        permissions: normalizePermissionList(d.get("permissions")),
        template: isRoleTemplateKey(template) ? template : null,
        sortOrder: typeof d.get("sortOrder") === "number" ? (d.get("sortOrder") as number) : 0,
        memberCount: memberCount.get(d.id) ?? 0,
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ko"));

  return { ok: true as const, roles };
});

/** 역할 생성(roleId 없음)·수정 — 수정 시 해당 역할 직원들의 권한도 즉시 갱신 */
export const saveAcademyRole = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireString(request.data?.academyId, "학원 ID가 필요합니다.");
  const roleIdRaw = request.data?.roleId;
  const roleId =
    roleIdRaw === undefined || roleIdRaw === null || roleIdRaw === ""
      ? null
      : requireString(roleIdRaw, "역할 ID가 올바르지 않습니다.");
  const name = parseRoleName(request.data?.name);
  const permissions = parsePermissions(request.data?.permissions);

  const db = admin.firestore();
  const actor = await assertPermission(
    db,
    academyId,
    request.auth.uid,
    request.auth.token,
    "settings.members",
  );

  if (!roleId) {
    const violation = roleSaveViolation(actor, {
      roleId: null,
      currentPermissions: null,
      nextPermissions: permissions,
    });
    if (violation) {
      throw new HttpsError("permission-denied", violation);
    }
    const all = await rolesCol(db, academyId).get();
    if (all.size >= MAX_ROLES_PER_ACADEMY) {
      throw new HttpsError(
        "resource-exhausted",
        `권한은 학원당 최대 ${MAX_ROLES_PER_ACADEMY}개까지 만들 수 있습니다.`,
      );
    }
    const maxOrder = all.docs.reduce((m, d) => {
      const o = d.get("sortOrder");
      return typeof o === "number" && o > m ? o : m;
    }, -1);
    const ref = rolesCol(db, academyId).doc();
    await ref.set({
      name,
      permissions,
      template: null,
      sortOrder: maxOrder + 1,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ok: true as const, roleId: ref.id };
  }

  const ref = rolesCol(db, academyId).doc(roleId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "권한을 찾을 수 없습니다.");
  }
  const violation = roleSaveViolation(actor, {
    roleId,
    currentPermissions: normalizePermissionList(snap.get("permissions")),
    nextPermissions: permissions,
  });
  if (violation) {
    throw new HttpsError("permission-denied", violation);
  }
  await ref.update({ name, permissions, updatedAt: FieldValue.serverTimestamp() });
  await syncRolePermissionsToStaff(db, academyId, roleId, permissions);
  return { ok: true as const, roleId };
});

/** 사용자 정의 역할 삭제 — 템플릿과 직원이 배정된 역할은 삭제 불가 */
export const deleteAcademyRole = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireString(request.data?.academyId, "학원 ID가 필요합니다.");
  const roleId = requireString(request.data?.roleId, "역할 ID가 올바르지 않습니다.");

  const db = admin.firestore();
  const actor = await assertPermission(
    db,
    academyId,
    request.auth.uid,
    request.auth.token,
    "settings.members",
  );

  const ref = rolesCol(db, academyId).doc(roleId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "권한을 찾을 수 없습니다.");
  }
  const violation = roleDeleteViolation(actor, {
    roleId,
    currentPermissions: normalizePermissionList(snap.get("permissions")),
  });
  if (violation) {
    throw new HttpsError("permission-denied", violation);
  }
  if (isRoleTemplateKey(snap.get("template"))) {
    throw new HttpsError("failed-precondition", "기본 권한은 삭제할 수 없습니다.");
  }
  const inUse = await staffCol(db, academyId).where("roleId", "==", roleId).limit(1).get();
  if (!inUse.empty) {
    throw new HttpsError(
      "failed-precondition",
      "이 권한을 쓰는 직원이 있습니다. 다른 권한으로 바꾼 뒤 삭제해 주세요.",
    );
  }
  await ref.delete();
  return { ok: true as const };
});

/**
 * 직원에게 역할 배정 — 직원은 본인 역할을 바꿀 수 없고, 본인 권한을 넘는 역할을 주거나
 * 본인보다 넓은 권한의 직원을 바꿀 수 없음(`role-policy.ts`)
 */
export const assignStaffRole = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireString(request.data?.academyId, "학원 ID가 필요합니다.");
  const staffId = requireString(request.data?.staffId, "직원 정보가 올바르지 않습니다.");
  const roleId = requireString(request.data?.roleId, "역할 ID가 올바르지 않습니다.");

  const db = admin.firestore();
  const actor = await assertPermission(
    db,
    academyId,
    request.auth.uid,
    request.auth.token,
    "settings.members",
  );
  await ensureAcademyRoleTemplates(db, academyId);
  const [staffSnap, roleSnap] = await Promise.all([
    staffCol(db, academyId).doc(staffId).get(),
    rolesCol(db, academyId).doc(roleId).get(),
  ]);
  if (!staffSnap.exists) {
    throw new HttpsError("not-found", "직원 정보를 찾을 수 없습니다.");
  }
  if (!roleSnap.exists) {
    throw new HttpsError("not-found", "권한을 찾을 수 없습니다.");
  }
  const permissions = normalizePermissionList(roleSnap.get("permissions"));
  const violation = roleAssignViolation(actor, {
    staffId,
    staffCurrentPermissions: normalizePermissionList(staffSnap.get("permissions")),
    rolePermissions: permissions,
  });
  if (violation) {
    throw new HttpsError("permission-denied", violation);
  }
  await staffSnap.ref.update({
    roleId,
    permissions,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true as const, roleId, permissions };
});
