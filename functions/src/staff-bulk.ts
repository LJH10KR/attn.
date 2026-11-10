import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { actorHasPermission, assertPermission } from "./lib/academy-access";
import { assertKrPhoneRequired } from "./lib/kr-phone";
import {
  BULK_STAFF_MSG,
  MAX_BULK_STAFF,
  staffConflictMessage,
  staffPhoneConflict,
  validateBulkStaffInput,
  type ExistingStaffPhoneRow,
} from "./lib/staff-bulk";
import { staffPhoneMatchKey } from "./lib/staff-phone-match";
import { newNoAccountStaffFields } from "./staff";
import { resolveGrantableRole } from "./staff-accounts";

/**
 * 직원 여러 명 미리 등록 표(2-M, L4-2-2) — 계정 없는 직원(인사 기록) + "가입하면 줄 권한"(`signupRoleId`).
 * 권한: 인사 기록을 만드는 일은 `settings.staff`(`saveStaffMember`와 같음), 권한 칸은 `settings.members` +
 * 줄 수 있는 역할 검사(`setStaffSignupRole`과 같은 `resolveGrantableRole`). 한 번 최대 50명, 줄마다 성공/실패.
 * 번호는 문자로 확인한 번호가 아니므로 확인 표시를 쓰지 않는다(아이디·비밀번호 찾기에 쓰이지 않음).
 * 직원 가입 QR로 같은 번호가 가입·문자 확인하고 후보가 1명 + 권한이 있으면 바로 활성(2-L `tryAutoActivateStaff`).
 */

const MAX_ROW_KEY_LENGTH = 64;
const WRITE_FAILED_MSG = "저장하지 못했어요. 다시 시도해 주세요.";

type RowResult =
  | { rowKey: string; ok: true; staffId: string; signupRoleId: string | null }
  | {
      rowKey: string;
      ok: false;
      code: "invalid" | "duplicate_in_table" | "duplicate_phone" | "role" | "write_failed";
      message: string;
      conflict?: "pre_registered" | "account";
    };

function requireString(raw: unknown, message: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.includes("/")) {
    throw new HttpsError("invalid-argument", message);
  }
  return s;
}

export const createStaffPreRegistrations = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const callerUid = request.auth.uid;
  const academyId = requireString(request.data?.academyId, "학원 ID가 필요합니다.");
  const rawRows: unknown = request.data?.rows;
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw new HttpsError("invalid-argument", "저장할 직원이 없습니다.");
  }
  if (rawRows.length > MAX_BULK_STAFF) {
    throw new HttpsError("invalid-argument", `한 번에 ${MAX_BULK_STAFF}명까지 저장할 수 있어요.`);
  }
  const rows = rawRows.map((r) => (r ?? {}) as Record<string, unknown>);
  const rowKeys = rows.map((r) => {
    const k = typeof r.rowKey === "string" ? r.rowKey.trim() : "";
    if (!k || k.length > MAX_ROW_KEY_LENGTH) throw new HttpsError("invalid-argument", "표 줄 정보가 올바르지 않습니다.");
    return k;
  });
  if (new Set(rowKeys).size !== rowKeys.length) {
    throw new HttpsError("invalid-argument", "표 줄 정보가 올바르지 않습니다.");
  }

  const db = admin.firestore();
  const actor = await assertPermission(db, academyId, callerUid, request.auth.token, "settings.staff");
  const canSetRole = actorHasPermission(actor, "settings.members");
  const staffCol = db.collection(`academies/${academyId}/staff`);
  const existingSnap = await staffCol.select("status", "employmentStatus", "isGuest", "phone").get();
  const existing: ExistingStaffPhoneRow[] = existingSnap.docs.map((d) => ({
    status: d.get("status"),
    employmentStatus: d.get("employmentStatus"),
    isGuest: d.get("isGuest"),
    phone: d.get("phone"),
  }));

  // 같은 표 안 번호 중복은 오류(둘 다 들어가면 자동 활성 후보가 2명)
  const keyCount = new Map<string, number>();
  for (const r of rows) {
    const k = staffPhoneMatchKey(r.phone);
    if (k) keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
  }

  const roleCache = new Map<string, Promise<string>>();
  const grantable = (roleId: string) => {
    if (!roleCache.has(roleId)) {
      roleCache.set(roleId, resolveGrantableRole(db, academyId, actor, roleId).then((r) => r.roleId));
    }
    return roleCache.get(roleId)!;
  };

  const results: RowResult[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const rowKey = rowKeys[index]!;
    const displayName = typeof row.displayName === "string" ? row.displayName.trim() : "";
    const phoneRaw = typeof row.phone === "string" ? row.phone : "";
    const errors = validateBulkStaffInput({ displayName, phone: phoneRaw });
    if (errors.length > 0) {
      results.push({ rowKey, ok: false, code: "invalid", message: errors[0]!.message });
      continue;
    }
    let phone: string;
    try {
      // +82·82로 시작해도 같은 번호로(검사와 같은 규칙) → 저장 형식 010-1234-5678
      phone = assertKrPhoneRequired(staffPhoneMatchKey(phoneRaw) || phoneRaw);
    } catch (e) {
      if (!(e instanceof HttpsError)) throw e;
      results.push({ rowKey, ok: false, code: "invalid", message: e.message });
      continue;
    }
    if ((keyCount.get(staffPhoneMatchKey(phone)) ?? 0) > 1) {
      results.push({ rowKey, ok: false, code: "duplicate_in_table", message: BULK_STAFF_MSG.duplicateInTable });
      continue;
    }
    const conflict = staffPhoneConflict(existing, phone);
    if (conflict && row.allowDuplicatePhone !== true) {
      results.push({ rowKey, ok: false, code: "duplicate_phone", message: staffConflictMessage(conflict), conflict });
      continue;
    }
    const roleRaw = typeof row.signupRoleId === "string" && row.signupRoleId.trim() ? row.signupRoleId.trim() : null;
    let signupRoleId: string | null = null;
    if (roleRaw) {
      if (!canSetRole) {
        results.push({ rowKey, ok: false, code: "role", message: BULK_STAFF_MSG.roleNoPermission });
        continue;
      }
      try {
        signupRoleId = await grantable(roleRaw);
      } catch (e) {
        if (!(e instanceof HttpsError)) throw e;
        results.push({ rowKey, ok: false, code: "role", message: e.message });
        continue;
      }
    }
    const ref = staffCol.doc();
    try {
      await ref.set({
        ...newNoAccountStaffFields(academyId, {
          displayName,
          phone,
          jobTitleId: null,
          hireDate: null,
          employmentStatus: "employed",
          memo: "",
          updatedAt: FieldValue.serverTimestamp(),
        }),
        ...(signupRoleId ? { signupRoleId, signupRoleSetByUid: callerUid } : {}),
      });
    } catch {
      results.push({ rowKey, ok: false, code: "write_failed", message: WRITE_FAILED_MSG });
      continue;
    }
    // 같은 호출 안 다음 줄의 중복 판단에도 반영
    existing.push({ status: "no_account", employmentStatus: "employed", isGuest: false, phone });
    results.push({ rowKey, ok: true, staffId: ref.id, signupRoleId });
  }

  const createdCount = results.filter((r) => r.ok).length;
  return { ok: true as const, results, createdCount, failedCount: rows.length - createdCount };
});
