import { normalizePermissionList, type AcademyPermission } from "@/lib/academy/permissions";
import { isStaffSignupMatchCandidate } from "@/lib/academy/staff-phone-match";
import {
  readStaffEmploymentStatus,
  type StaffAccountStatus,
  type StaffEmploymentStatus,
} from "@/lib/firebase/attn-schema";

/** 직원 관리 화면의 직원 한 줄 — `academies/{academyId}/staff/{staffId}` */
export type StaffRowVM = {
  id: string;
  displayName: string;
  phone: string;
  jobTitleId: string | null;
  hireDate: string | null;
  employmentStatus: StaffEmploymentStatus;
  memo: string;
  accountStatus: StaffAccountStatus;
  isGuest: boolean;
  /** 미리 등록(계정 없음일 때) — 가입하면 줄 역할(2-K) */
  signupRoleId: string | null;
  /** 계정이 있을 때 — 로그인 ID(Google 가입이면 빈 문자열) */
  loginId: string;
  roleId: string | null;
  /** 역할에서 서버가 복사한 권한 — 본인보다 넓은 권한 직원 판별용 */
  permissions: AcademyPermission[];
  authProvider: "password" | "google";
};

export function docToStaffRow(id: string, data: Record<string, unknown>): StaffRowVM {
  return {
    id,
    displayName: typeof data.displayName === "string" ? data.displayName : "",
    phone: typeof data.phone === "string" ? data.phone : "",
    jobTitleId: typeof data.jobTitleId === "string" ? data.jobTitleId : null,
    hireDate: typeof data.hireDate === "string" ? data.hireDate : null,
    employmentStatus: readStaffEmploymentStatus(data.employmentStatus),
    memo: typeof data.memo === "string" ? data.memo : "",
    accountStatus: (data.status as StaffAccountStatus) || "pending_setup",
    isGuest: data.isGuest === true,
    signupRoleId: typeof data.signupRoleId === "string" && data.signupRoleId ? data.signupRoleId : null,
    loginId: typeof data.loginId === "string" ? data.loginId : "",
    roleId: typeof data.roleId === "string" && data.roleId ? data.roleId : null,
    permissions: normalizePermissionList(data.permissions),
    authProvider: data.authProvider === "google" ? "google" : "password",
  };
}

/** 계정 상태 배지 문구 */
export function staffAccountLabel(row: Pick<StaffRowVM, "accountStatus" | "signupRoleId">): string {
  switch (row.accountStatus) {
    case "no_account":
      return row.signupRoleId ? "계정 없음 · 미리 등록" : "계정 없음";
    case "active":
      return "계정 사용 중";
    case "inactive":
      return "계정 비활성";
    case "pending_registration":
      return "가입 승인 대기";
    case "pending_setup":
      return "첫 로그인 전";
    default:
      return "계정 확인 필요";
  }
}

/** 승인 대기 계정과 같은 번호로 미리 등록한 직원(계정 없음·퇴사 아님·게스트 아님) — 서버 합치기와 같은 규칙 */
export function staffSignupMatches(rows: readonly StaffRowVM[], account: Pick<StaffRowVM, "phone">): StaffRowVM[] {
  return rows.filter((r) =>
    isStaffSignupMatchCandidate(
      { status: r.accountStatus, employmentStatus: r.employmentStatus, isGuest: r.isGuest, phone: r.phone },
      account.phone,
    ),
  );
}
