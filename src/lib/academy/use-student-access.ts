"use client";

import { useMemo } from "react";
import type { AcademyPermission } from "@/lib/academy/permissions";
import { isActiveStudent, type StudentStatus } from "@/lib/academy/student-profile";
import type { AcademyPermissionState } from "@/lib/academy/use-permissions";

/**
 * 학생 상세·원생 화면에서 무엇을 보여 줄지 — 설계 문서 4-4절 표 그대로, `firestore.rules`와 서버 검사에 맞춘다.
 * 실제 차단은 규칙·서버가 하므로 여기서는 노출만 정한다. 원생·반·학부모·출결·수납 화면과
 * 선생님 화면(`/teacher`)이 모두 이 판단 하나를 쓴다.
 */

export const STUDENT_DETAIL_TABS = ["info", "attendance", "billing"] as const;
export type StudentDetailTab = (typeof STUDENT_DETAIL_TABS)[number];

export function isStudentDetailTab(raw: unknown): raw is StudentDetailTab {
  return typeof raw === "string" && (STUDENT_DETAIL_TABS as readonly string[]).includes(raw);
}

/** 판단에 필요한 학생 값 — 담당 선생님(반에서 서버 계산)·상태 */
export type StudentAccessTarget = { teacherUids: readonly string[]; status: StudentStatus };

type HasAny = (required: AcademyPermission | readonly AcademyPermission[]) => boolean;

export type StudentAccess = {
  /** 학생 문서 읽기(정보 탭) — 학생 메뉴 권한 7개 중 하나 또는 `teacherUids`에 본인 */
  canReadStudent: (s: StudentAccessTarget) => boolean;
  /** 원생 추가·정보 수정·상태 변경·삭제(`saveStudent`·`deleteAcademyStudent`) */
  manage: boolean;
  /** 메모(`studentNotes`) 읽기·CSV 메모 열 */
  readNotes: boolean;
  /** 출결 탭(`attendanceRecords` 읽기) */
  attendanceTab: boolean;
  /** 결석 기록·출결 기록 정정(`recordStudentAbsences`·`deleteStudentAttendanceRecord`) */
  recordAbsence: boolean;
  /** 결제 탭 */
  billingTab: boolean;
  /** 원비 설정·충전(학생 원비 필드, D11) — 학원 기본 원비 설정도 같은 권한 */
  tuitionEdit: boolean;
  /** 수업 완료(회차 차감 + sessionLogs) */
  sessionComplete: boolean;
  /** 회차 기록(sessionLogs 읽기) — 원장·활성 직원 */
  sessionLogs: boolean;
  /** 청구서 목록(tuitionInvoices 읽기) */
  invoices: boolean;
  /** 청구서 관리(조정·납부 표시 — 서버 `billing.invoices`) */
  manageInvoices: boolean;
  /** 결제 내역(payments 읽기) */
  payments: boolean;
  /** 반 이름(classes 읽기 — 원장·활성 직원) */
  readClasses: boolean;
  /** 학생 상세 "등원 알림" — 등원 처리 권한 + 재원 */
  notifyPresent: (s: StudentAccessTarget) => boolean;
  /** 등원·미등원 처리(`recordStudentArrival`) — 출결 권한 또는 담당 학생(재원 여부는 버튼 상태로) */
  canMarkArrival: (s: StudentAccessTarget) => boolean;
  /** 반 출석·결석(`recordClassAttendance`) — 출결 권한 또는 그 반 선생님(반 teacherUids) */
  canMarkClass: (cls: { teacherUids: readonly string[] }) => boolean;
  /**
   * 그 반 오늘 출결 읽기(규칙과 같게) — 출결·청구서 권한 또는 그 반 선생님.
   * 이 값이 false면 구독하지 않는다(규칙 거부 문서 구독은 SDK 내부 오류 위험, 2-I B1).
   */
  readClassAttendance: (cls: { teacherUids: readonly string[] }) => boolean;
  /** 보여 줄 상세 탭(순서대로) */
  tabs: (s: StudentAccessTarget) => StudentDetailTab[];
};

const STUDENT_READ_PERMISSIONS: readonly AcademyPermission[] = [
  "operations.students",
  "operations.parents",
  "operations.classes",
  "lessons.attendance",
  "billing.invoices",
  "billing.collections",
  "billing.payments",
];

/**
 * @param viewerUid 원장 또는 활성 직원일 때만 값이 있음(`usePermissions().viewer`) — 학원과 무관하면 null
 */
export function studentAccess(can: HasAny, viewerUid: string | null): StudentAccess {
  const isMember = viewerUid !== null;
  const assigned = (s: StudentAccessTarget) => viewerUid !== null && s.teacherUids.includes(viewerUid);
  const canReadStudent = (s: StudentAccessTarget) => can(STUDENT_READ_PERMISSIONS) || assigned(s);
  const attendanceTab = can(["lessons.attendance", "billing.invoices"]);
  const billingTab = can([
    "billing.invoices",
    "billing.collections",
    "billing.payments",
    "billing.refunds",
    "operations.students",
  ]);
  return {
    canReadStudent,
    manage: can("operations.students"),
    readNotes: can("operations.students"),
    attendanceTab,
    recordAbsence: can("lessons.attendance"),
    billingTab,
    tuitionEdit: can(["operations.students", "billing.invoices"]),
    sessionComplete: can(["operations.students", "lessons.attendance", "billing.invoices"]),
    // 규칙: 출결·청구서 권한 또는 활성 직원 — 권한을 가진 직원도 활성 직원이므로 원장·활성 직원이면 충분
    sessionLogs: isMember,
    invoices: can(["billing.invoices", "billing.collections"]),
    manageInvoices: can("billing.invoices"),
    payments: can(["billing.payments", "billing.collections", "billing.refunds"]),
    readClasses: isMember,
    notifyPresent: (s) => (can("lessons.attendance") || assigned(s)) && isActiveStudent(s),
    canMarkArrival: (s) => can("lessons.attendance") || assigned(s),
    canMarkClass: (cls) => can("lessons.attendance") || (viewerUid !== null && cls.teacherUids.includes(viewerUid)),
    readClassAttendance: (cls) =>
      attendanceTab || (viewerUid !== null && cls.teacherUids.includes(viewerUid)),
    tabs: (s) => {
      if (!canReadStudent(s)) return [];
      const list: StudentDetailTab[] = ["info"];
      if (attendanceTab) list.push("attendance");
      if (billingTab) list.push("billing");
      return list;
    },
  };
}

export function useStudentAccess(
  permissions: Pick<AcademyPermissionState, "can" | "viewer">,
): StudentAccess {
  const { can, viewer } = permissions;
  const uid = viewer?.uid ?? null;
  return useMemo(() => studentAccess(can, uid), [can, uid]);
}
