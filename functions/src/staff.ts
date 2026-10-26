import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { assertPermission } from "./lib/academy-access";
import { parseOptionalKrPhone } from "./lib/kr-phone";
import { DEFAULT_STAFF_ROLE_ID, normalizePermissionList } from "./lib/permissions";
import { staffAccountChangeViolation } from "./lib/role-policy";
import { academyOptionsRef, readOptionItems } from "./academy-options";
import { deactivateStaffAccount } from "./teachers";

/**
 * 설정 › 직원 관리 — `academies/{academyId}/staff/{staffId}`의 인사 정보.
 * 계정(초대·활성·권한)은 멤버 관리(`teachers.ts`, `roles.ts`)에서 다루고,
 * 계정 없이 등록한 직원은 `status: "no_account"`(문서 ID 임의, 계정 연결 시 Auth uid로 이전).
 * 게스트(`isGuest`)는 인사 정보가 없는 계정이라 여기서 다루지 않는다.
 */

export const EMPLOYMENT_STATUSES = ["employed", "on_leave", "resigned"] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

const MAX_NAME_LENGTH = 60;
const MAX_MEMO_LENGTH = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireString(raw: unknown, message: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.includes("/")) {
    throw new HttpsError("invalid-argument", message);
  }
  return s;
}

function parseEmploymentStatus(raw: unknown): EmploymentStatus {
  if (typeof raw === "string" && (EMPLOYMENT_STATUSES as readonly string[]).includes(raw)) {
    return raw as EmploymentStatus;
  }
  throw new HttpsError("invalid-argument", "재직 상태가 올바르지 않습니다.");
}

/** "YYYY-MM-DD" 또는 빈 값 — 실존 날짜만 */
function parseOptionalDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || !DATE_RE.test(raw)) {
    throw new HttpsError("invalid-argument", "입사일 형식이 올바르지 않습니다.");
  }
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    throw new HttpsError("invalid-argument", "입사일 형식이 올바르지 않습니다.");
  }
  return raw;
}

/** 직무 — 학원 선택지 목록(jobTitles)에 있는 id만, 없으면 null */
async function parseJobTitleId(
  db: admin.firestore.Firestore,
  academyId: string,
  raw: unknown,
): Promise<string | null> {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") {
    throw new HttpsError("invalid-argument", "직무가 올바르지 않습니다.");
  }
  const snap = await academyOptionsRef(db, academyId).get();
  const exists = readOptionItems(snap.get("jobTitles")).some((o) => o.id === raw);
  if (!exists) {
    throw new HttpsError("failed-precondition", "선택한 직무가 삭제되었습니다. 다시 선택해 주세요.");
  }
  return raw;
}

/** 직원 추가(staffId 없음)·인사 정보 수정. 퇴사로 바꾸면 활성 계정도 함께 비활성화 */
export const saveStaffMember = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireString(request.data?.academyId, "학원 ID가 필요합니다.");
  const staffIdRaw = request.data?.staffId;
  const staffId =
    staffIdRaw === undefined || staffIdRaw === null || staffIdRaw === ""
      ? null
      : requireString(staffIdRaw, "직원 정보가 올바르지 않습니다.");

  const displayName = typeof request.data?.displayName === "string"
    ? request.data.displayName.trim()
    : "";
  if (!displayName || displayName.length > MAX_NAME_LENGTH) {
    throw new HttpsError("invalid-argument", `이름을 1~${MAX_NAME_LENGTH}자로 입력해 주세요.`);
  }
  const phone = parseOptionalKrPhone(request.data?.phone);
  const hireDate = parseOptionalDate(request.data?.hireDate);
  const employmentStatus = parseEmploymentStatus(request.data?.employmentStatus ?? "employed");
  const memo = typeof request.data?.memo === "string"
    ? request.data.memo.trim().slice(0, MAX_MEMO_LENGTH)
    : "";

  const db = admin.firestore();
  const actor = await assertPermission(
    db,
    academyId,
    request.auth.uid,
    request.auth.token,
    "settings.staff",
  );
  const jobTitleId = await parseJobTitleId(db, academyId, request.data?.jobTitleId);

  const hr = {
    displayName,
    phone,
    jobTitleId,
    hireDate,
    employmentStatus,
    memo,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (!staffId) {
    const ref = db.collection(`academies/${academyId}/staff`).doc();
    await ref.set({
      ...hr,
      academyId,
      status: "no_account",
      authUid: null,
      isGuest: false,
      roleId: DEFAULT_STAFF_ROLE_ID,
      permissions: [],
      createdAt: FieldValue.serverTimestamp(),
    });
    return { ok: true as const, staffId: ref.id, accountDeactivated: false };
  }

  const ref = db.doc(`academies/${academyId}/staff/${staffId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "직원 정보를 찾을 수 없습니다.");
  }
  if (snap.get("isGuest") === true) {
    throw new HttpsError("failed-precondition", "게스트 계정은 직원 정보를 수정할 수 없습니다.");
  }

  const becomesResigned =
    employmentStatus === "resigned" && snap.get("employmentStatus") !== "resigned";
  const deactivateAccount = becomesResigned && snap.get("status") === "active";
  if (deactivateAccount) {
    const violation = staffAccountChangeViolation(actor, {
      staffId,
      staffCurrentPermissions: normalizePermissionList(snap.get("permissions")),
    });
    if (violation) {
      throw new HttpsError("permission-denied", violation);
    }
  }

  await ref.update(hr);
  if (deactivateAccount) {
    await deactivateStaffAccount(db, academyId, staffId);
  }
  return { ok: true as const, staffId, accountDeactivated: deactivateAccount };
});

/** 계정이 없는 직원만 삭제 — 계정이 있으면 퇴사 처리 후 멤버 관리에서 계정을 정리 */
export const deleteStaffMember = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireString(request.data?.academyId, "학원 ID가 필요합니다.");
  const staffId = requireString(request.data?.staffId, "직원 정보가 올바르지 않습니다.");

  const db = admin.firestore();
  await assertPermission(db, academyId, request.auth.uid, request.auth.token, "settings.staff");

  const ref = db.doc(`academies/${academyId}/staff/${staffId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "직원 정보를 찾을 수 없습니다.");
  }
  if (snap.get("status") !== "no_account") {
    throw new HttpsError(
      "failed-precondition",
      "계정이 있는 직원은 삭제할 수 없습니다. 퇴사 처리한 뒤 멤버 관리에서 계정을 정리해 주세요.",
    );
  }
  await ref.delete();
  return { ok: true as const };
});
