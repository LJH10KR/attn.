/**
 * 직원 여러 명 미리 등록 표(2-M) — 줄 검사·번호 중복 판단.
 * 서버 `functions/src/lib/staff-bulk.ts` ↔ 화면 `src/lib/academy/staff-bulk.ts`(같은 내용, 단위 테스트가 비교).
 * 번호 비교는 직원 가입 자동 활성과 같은 규칙(`staff-phone-match.ts`).
 */

import { staffPhoneMatchKey } from "./staff-phone-match";

export const MAX_BULK_STAFF = 50;
export const BULK_STAFF_NAME_MAX = 60;

/** 서버에 보내는 한 줄 */
export type BulkStaffInput = {
  rowKey: string;
  displayName: string;
  phone: string;
  /** 가입하면 줄 권한 — 없으면 null(가입하면 승인 대기) */
  signupRoleId: string | null;
  /** 기존 직원과 같은 번호여도 저장 */
  allowDuplicatePhone: boolean;
};

export type BulkStaffField = "displayName" | "phone" | "signupRoleId" | "row";
export type BulkStaffError = { field: BulkStaffField; message: string };

export const BULK_STAFF_MSG = {
  nameRequired: "이름을 입력해 주세요.",
  nameTooLong: `이름은 ${BULK_STAFF_NAME_MAX}자 이하로 입력해 주세요.`,
  phoneRequired: "휴대폰 번호를 입력해 주세요.",
  phoneFormat: "휴대폰 번호 형식을 확인해 주세요(010으로 시작하는 10~11자리).",
  duplicateInTable: "표 안에 같은 번호가 있어요. 한 명만 남겨 주세요.",
  conflictPreRegistered: "같은 번호의 미리 등록 직원이 있어요. 둘 다 있으면 가입할 때 바로 활성되지 않아요.",
  conflictAccount: "이미 계정이 있는 직원의 번호예요.",
  roleNoPermission: "권한은 멤버 관리 권한이 있는 분이 정해요. 권한 칸을 비워 주세요.",
} as const;

/** 이름·번호 검사(값 단계 — 화면·서버 공통) */
export function validateBulkStaffInput(input: Pick<BulkStaffInput, "displayName" | "phone">): BulkStaffError[] {
  const errors: BulkStaffError[] = [];
  const name = typeof input.displayName === "string" ? input.displayName.trim() : "";
  if (!name) errors.push({ field: "displayName", message: BULK_STAFF_MSG.nameRequired });
  else if (name.length > BULK_STAFF_NAME_MAX) errors.push({ field: "displayName", message: BULK_STAFF_MSG.nameTooLong });
  const phoneRaw = typeof input.phone === "string" ? input.phone.trim() : "";
  if (!phoneRaw) errors.push({ field: "phone", message: BULK_STAFF_MSG.phoneRequired });
  else if (!staffPhoneMatchKey(phoneRaw)) errors.push({ field: "phone", message: BULK_STAFF_MSG.phoneFormat });
  return errors;
}

/** 표 안에서 번호가 같은 줄의 위치(2줄 이상인 것만) */
export function bulkStaffDuplicatePhones(phones: readonly string[]): Set<number> {
  const seen = new Map<string, number[]>();
  phones.forEach((p, i) => {
    const k = staffPhoneMatchKey(p);
    if (!k) return;
    seen.set(k, [...(seen.get(k) ?? []), i]);
  });
  const out = new Set<number>();
  for (const idx of seen.values()) if (idx.length > 1) idx.forEach((i) => out.add(i));
  return out;
}

/** 기존 직원 문서 중 비교에 필요한 값 */
export type ExistingStaffPhoneRow = {
  status: unknown;
  employmentStatus: unknown;
  isGuest: unknown;
  phone: unknown;
};

/**
 * 기존 직원과 번호가 겹치는지 — 계정 없는 직원(퇴사·게스트 제외)과 같으면 "pre_registered"(자동 활성 후보가 2명이 됨),
 * 계정이 있는 직원(퇴사 제외)과 같으면 "account". 둘 다 있으면 "pre_registered"를 먼저.
 */
export function staffPhoneConflict(
  existing: readonly ExistingStaffPhoneRow[],
  phone: string,
): "pre_registered" | "account" | null {
  const key = staffPhoneMatchKey(phone);
  if (!key) return null;
  let account = false;
  for (const row of existing) {
    if (row.isGuest === true || row.employmentStatus === "resigned") continue;
    if (staffPhoneMatchKey(row.phone) !== key) continue;
    if (row.status === "no_account") return "pre_registered";
    account = true;
  }
  return account ? "account" : null;
}

export function staffConflictMessage(kind: "pre_registered" | "account"): string {
  return kind === "pre_registered" ? BULK_STAFF_MSG.conflictPreRegistered : BULK_STAFF_MSG.conflictAccount;
}
