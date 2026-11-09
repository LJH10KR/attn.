import * as admin from "firebase-admin";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { assertPermission, type AcademyActor } from "./lib/academy-access";
import { DEFAULT_STAFF_ROLE_ID, type AcademyPermission } from "./lib/permissions";
import { roleAssignViolation } from "./lib/role-policy";
import {
  loadRolePermissions,
  provisionStaffAccount,
  type ProvisionedStaffAccount,
} from "./lib/staff-account";

/**
 * 직원 계정 직접 만들어 주기(설정 › 멤버 초대 › 계정 직접 만들기) — 자동 로그인 ID + 임시 비밀번호를 바로 발급
 * (최초 로그인 시 비밀번호 변경 후 활성). 휴대폰이 없거나 가입이 어려운 사람용.
 * 직원 1인 초대 링크(`staffInvites`)는 2-K에서 폐지 — 학원 공용 직원 가입 링크는 `staff-signup.ts`.
 */

const MAX_ACCOUNTS_PER_REQUEST = 10;
const MAX_NAME_LENGTH = 60;

function requireString(raw: unknown, message: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.includes("/")) {
    throw new HttpsError("invalid-argument", message);
  }
  return s;
}

/** 기존 직원(staffId) 또는 새 직원 이름(displayName) 형식 확인 — Firestore 조회 없음 */
function assertAccountTargetInput(raw: { staffId?: unknown; displayName?: unknown }): void {
  const staffId = typeof raw.staffId === "string" ? raw.staffId.trim() : "";
  if (staffId) {
    requireString(staffId, "직원 정보가 올바르지 않습니다.");
    return;
  }
  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  if (!displayName || displayName.length > MAX_NAME_LENGTH) {
    throw new HttpsError("invalid-argument", `이름을 1~${MAX_NAME_LENGTH}자로 입력해 주세요.`);
  }
}

/** 지금 계정 발급이 가능한 직원 문서 — 없으면 이름으로 새 직원(계정 없음)을 만든다(created) */
async function resolveAccountTarget(
  db: admin.firestore.Firestore,
  academyId: string,
  raw: { staffId?: unknown; displayName?: unknown },
): Promise<{
  ref: DocumentReference;
  displayName: string;
  created: boolean;
}> {
  assertAccountTargetInput(raw);
  const staffId = typeof raw.staffId === "string" ? raw.staffId.trim() : "";
  if (staffId) {
    const ref = db.doc(`academies/${academyId}/staff/${staffId}`);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError("not-found", "직원 정보를 찾을 수 없습니다.");
    }
    if (snap.get("status") !== "no_account" || snap.get("isGuest") === true) {
      throw new HttpsError("failed-precondition", "이미 계정이 있는 직원입니다.");
    }
    if (snap.get("employmentStatus") === "resigned") {
      throw new HttpsError("failed-precondition", "퇴사 처리된 직원은 계정을 만들 수 없습니다.");
    }
    return {
      ref,
      displayName: typeof snap.get("displayName") === "string" ? snap.get("displayName") : "",
      created: false,
    };
  }

  const displayName = (raw.displayName as string).trim();
  const ref = db.collection(`academies/${academyId}/staff`).doc();
  await ref.set({
    displayName,
    phone: null,
    jobTitleId: null,
    hireDate: null,
    employmentStatus: "employed",
    memo: "",
    academyId,
    status: "no_account",
    authUid: null,
    isGuest: false,
    roleId: DEFAULT_STAFF_ROLE_ID,
    permissions: [],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ref, displayName, created: true };
}

export type GrantableRole = { roleId: string; permissions: AcademyPermission[] };

/** 부여할 역할 — 존재해야 하고, 직원은 본인 권한을 넘는 역할을 줄 수 없음 */
export async function resolveGrantableRole(
  db: admin.firestore.Firestore,
  academyId: string,
  actor: AcademyActor,
  rawRoleId: unknown,
): Promise<GrantableRole> {
  const roleId = requireString(rawRoleId ?? DEFAULT_STAFF_ROLE_ID, "권한을 선택해 주세요.");
  const permissions = await loadRolePermissions(db, academyId, roleId);
  if (!permissions) {
    throw new HttpsError("not-found", "권한을 찾을 수 없습니다.");
  }
  const violation = roleAssignViolation(actor, {
    staffId: "",
    staffCurrentPermissions: [],
    rolePermissions: permissions,
  });
  if (violation) {
    throw new HttpsError("permission-denied", violation);
  }
  return { roleId, permissions };
}

/**
 * 계정 직접 만들어 주기 — 최대 10명, 임시 비밀번호는 응답에서 한 번만 보여 줌.
 * 일부만 실패하면 `accounts`(성공분)와 `failures`(index·이름·사유)를 함께 돌려주고, 전부 실패하면 첫 오류를 던진다.
 */
export const createStaffAccounts = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireString(request.data?.academyId, "학원 ID가 필요합니다.");
  const items = request.data?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpsError("invalid-argument", "계정을 만들 직원을 선택해 주세요.");
  }
  if (items.length > MAX_ACCOUNTS_PER_REQUEST) {
    throw new HttpsError(
      "invalid-argument",
      `한 번에 최대 ${MAX_ACCOUNTS_PER_REQUEST}명까지 만들 수 있습니다.`,
    );
  }

  const db = admin.firestore();
  const actor = await assertPermission(
    db,
    academyId,
    request.auth.uid,
    request.auth.token,
    "settings.members",
  );

  // 입력·부여 권한은 하나라도 틀리면 아무것도 만들지 않음
  const rows = (items as unknown[]).map((raw) =>
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {},
  );
  const roleCache = new Map<string, GrantableRole>();
  const plans: Array<{ raw: Record<string, unknown>; role: GrantableRole }> = [];
  for (const raw of rows) {
    assertAccountTargetInput(raw);
    const key = typeof raw.roleId === "string" ? raw.roleId : DEFAULT_STAFF_ROLE_ID;
    let role = roleCache.get(key);
    if (!role) {
      role = await resolveGrantableRole(db, academyId, actor, raw.roleId);
      roleCache.set(key, role);
    }
    plans.push({ raw, role });
  }

  // 한 명씩 만들고, 중간에 실패해도 이미 만든 계정(임시 비밀번호 포함)은 돌려준다 — 다시 볼 방법이 없으므로
  const accounts: Array<ProvisionedStaffAccount & { staffId: string; index: number }> = [];
  const failures: Array<{ index: number; displayName: string; message: string }> = [];
  let firstError: unknown = null;
  for (const [index, { raw, role }] of plans.entries()) {
    let target: Awaited<ReturnType<typeof resolveAccountTarget>> | null = null;
    try {
      target = await resolveAccountTarget(db, academyId, raw);
      const account = await provisionStaffAccount({
        db,
        academyId,
        hrRef: target.ref,
        displayName: target.displayName,
        roleId: role.roleId,
        permissions: role.permissions,
        mode: { kind: "temp" },
        status: "pending_setup",
      });
      accounts.push({ ...account, staffId: account.authUid, index });
    } catch (e) {
      firstError ??= e;
      if (!(e instanceof HttpsError)) {
        logger.error("createStaffAccounts: item failed", { academyId, index, e });
      }
      // 이번 요청에서 이름만으로 새로 만든 직원 문서는 되돌림(남기면 계정 없는 직원이 생김)
      if (target?.created) {
        await target.ref.delete().catch(() => undefined);
      }
      failures.push({
        index,
        displayName:
          target?.displayName ?? (typeof raw.displayName === "string" ? raw.displayName.trim() : ""),
        message: e instanceof HttpsError ? e.message : "계정을 만들지 못했습니다.",
      });
    }
  }
  if (accounts.length === 0) {
    throw firstError;
  }
  return { ok: true as const, accounts, failures };
});
