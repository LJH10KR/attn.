import { Timestamp } from "firebase/firestore";
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
  /** 초대 링크 대기 중이면 만료 시각 */
  inviteExpiresAtMillis: number | null;
  inviteRoleId: string | null;
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
    inviteExpiresAtMillis:
      data.inviteExpiresAt instanceof Timestamp ? data.inviteExpiresAt.toMillis() : null,
    inviteRoleId: typeof data.inviteRoleId === "string" ? data.inviteRoleId : null,
  };
}

/** 초대 링크가 아직 유효한지(계정 없음 + 만료 전) */
export function staffHasPendingInvite(
  row: Pick<StaffRowVM, "accountStatus" | "inviteExpiresAtMillis">,
  now = Date.now(),
): boolean {
  return (
    row.accountStatus === "no_account" &&
    row.inviteExpiresAtMillis !== null &&
    row.inviteExpiresAtMillis > now
  );
}

/** 계정 상태 배지 문구 */
export function staffAccountLabel(
  row: Pick<StaffRowVM, "accountStatus" | "inviteExpiresAtMillis">,
): string {
  switch (row.accountStatus) {
    case "no_account":
      return staffHasPendingInvite(row) ? "초대 링크 보냄" : "계정 없음";
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
