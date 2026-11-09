import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import type { AcademyActor } from "./academy-access";
import { DEFAULT_STAFF_ROLE_ID, normalizePermissionList, type AcademyPermission } from "./permissions";
import { roleAssignViolation, staffAccountChangeViolation } from "./role-policy";
import { finishStaffActivation, HR_FIELDS } from "./staff-account";
import { isStaffSignupMatchCandidate, staffPhoneMatchKey } from "./staff-phone-match";

/**
 * 공용 직원 링크 가입 계정 ↔ 미리 등록한 직원(계정 없음, 번호 + 가입하면 줄 역할) 합치기(2-K).
 * 2-K는 원장이 승인 화면에서 고를 때만(`approveStaffSignupAsExisting`), 2-L은 번호 확인 뒤 서버가 바로 부른다(actor null).
 * 번호만으로 자동으로 합치거나 활성하지 않는다(2-K에는 번호 확인이 없음).
 */

export const MSG_STAFF_MERGE_STALE = "미리 등록한 직원 정보가 바뀌었습니다. 목록을 새로고침해 주세요.";

function candidateInput(snap: admin.firestore.DocumentSnapshot) {
  return {
    status: snap.get("status"),
    employmentStatus: snap.get("employmentStatus"),
    isGuest: snap.get("isGuest"),
    phone: snap.get("phone"),
  };
}

/** 가입한 번호와 같은 번호로 미리 등록한 직원(계정 없음·퇴사 아님·게스트 아님) — 2-L 자동 활성 판단용 */
export async function findStaffSignupMatches(
  db: admin.firestore.Firestore,
  academyId: string,
  phone: unknown,
): Promise<admin.firestore.QueryDocumentSnapshot[]> {
  if (!staffPhoneMatchKey(phone)) return [];
  const snap = await db.collection(`academies/${academyId}/staff`).where("status", "==", "no_account").get();
  return snap.docs.filter((d) => isStaffSignupMatchCandidate(candidateInput(d), phone));
}

/**
 * 가입 승인 대기 계정에 미리 등록한 직원의 인사 정보·역할을 합치고 활성화한다(트랜잭션) — 인사 문서는 지운다.
 * 역할은 미리 등록한 `signupRoleId`(지워졌거나 없으면 기본 역할), 권한은 지금 역할 문서에서 다시 읽는다.
 * `actor`가 있으면 계정 변경·역할 부여 권한을 검사한다(승인하는 사람이 미리 등록한 사람보다 권한이 좁을 수 있음).
 */
export async function mergeStaffSignupIntoRecord(
  db: admin.firestore.Firestore,
  params: { academyId: string; accountUid: string; hrStaffId: string; actor: AcademyActor | null },
): Promise<{ roleId: string; permissions: AcademyPermission[] }> {
  const { academyId, accountUid, hrStaffId, actor } = params;
  if (accountUid === hrStaffId) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }
  const accountRef = db.doc(`academies/${academyId}/staff/${accountUid}`);
  const hrRef = db.doc(`academies/${academyId}/staff/${hrStaffId}`);

  const result = await db.runTransaction(async (tx) => {
    const [account, hr] = await Promise.all([tx.get(accountRef), tx.get(hrRef)]);
    if (!account.exists || account.get("status") !== "pending_registration" || account.get("isGuest") === true) {
      throw new HttpsError("failed-precondition", "가입 승인 대기 중인 계정만 이 직원으로 승인할 수 있습니다.");
    }
    if (!hr.exists || !isStaffSignupMatchCandidate(candidateInput(hr), account.get("phone"))) {
      throw new HttpsError("failed-precondition", MSG_STAFF_MERGE_STALE);
    }
    const accountPermissions = normalizePermissionList(account.get("permissions"));
    if (actor) {
      const v = staffAccountChangeViolation(actor, { staffId: accountUid, staffCurrentPermissions: accountPermissions });
      if (v) throw new HttpsError("permission-denied", v);
    }

    const presetRoleId = hr.get("signupRoleId");
    const presetSnap =
      typeof presetRoleId === "string" && presetRoleId
        ? await tx.get(db.doc(`academies/${academyId}/roles/${presetRoleId}`))
        : null;
    const roleSnap = presetSnap?.exists
      ? presetSnap
      : await tx.get(db.doc(`academies/${academyId}/roles/${DEFAULT_STAFF_ROLE_ID}`));
    const roleId = presetSnap?.exists ? (presetRoleId as string) : DEFAULT_STAFF_ROLE_ID;
    const permissions = roleSnap.exists ? normalizePermissionList(roleSnap.get("permissions")) : [];
    if (actor) {
      const v = roleAssignViolation(actor, {
        staffId: accountUid,
        staffCurrentPermissions: accountPermissions,
        rolePermissions: permissions,
      });
      if (v) throw new HttpsError("permission-denied", v);
    }

    const hrFields: Record<string, unknown> = {};
    for (const k of HR_FIELDS) {
      const v = hr.get(k);
      if (v !== undefined) hrFields[k] = v;
    }
    const hrName = typeof hr.get("displayName") === "string" ? (hr.get("displayName") as string).trim() : "";
    tx.update(accountRef, {
      ...hrFields,
      displayName: hrName || account.get("displayName") || "",
      roleId,
      permissions,
      status: "active",
      activatedAt: FieldValue.serverTimestamp(),
      mergedFromStaffId: hrStaffId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.delete(hrRef);
    return { roleId, permissions };
  });

  await finishStaffActivation(academyId, accountUid);
  return result;
}
