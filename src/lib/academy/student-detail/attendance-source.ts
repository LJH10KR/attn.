import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import {
  academyStudentAttendanceRecordsPath,
  isAbsenceReason,
  type AbsenceReason,
} from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";

/**
 * 학생 상세 출결 탭의 데이터 출처 — 지금은 학생 하위 `attendanceRecords`(학생·날짜당 1건).
 * 3단계 출결(`attendance/{date}_{classId}_{studentId}`)로 바뀌면 이 파일만 바꾸고 시트는 그대로 둔다.
 * 읽기 권한: `lessons.attendance`·`billing.invoices`(규칙).
 */

export type StudentAttendanceRow = {
  /** 서울 기준 YYYY-MM-DD */
  date: string;
  status: "present" | "absent";
  reason: AbsenceReason | null;
  note: string;
  recordedByRole: string;
  /** 결석 차감이 반영된 청구서(YYYY-MM) — 있으면 수정·삭제 잠금 */
  billedInvoicePeriod: string | null;
};

/** `from`~`to`(YYYY-MM-DD, 양 끝 포함) 기록, 최근 날짜부터 */
export async function loadStudentAttendance(
  academyId: string,
  studentId: string,
  range: { from: string; to: string },
): Promise<StudentAttendanceRow[]> {
  const snap = await getDocs(
    query(
      collection(getFirebaseDb(), academyStudentAttendanceRecordsPath(academyId, studentId)),
      where("date", ">=", range.from),
      where("date", "<=", range.to),
      orderBy("date", "desc"),
    ),
  );
  return snap.docs.map((d) => {
    const x = d.data();
    return {
      date: typeof x.date === "string" ? x.date : d.id,
      status: x.status === "absent" ? "absent" : "present",
      reason: isAbsenceReason(x.reason) ? x.reason : null,
      note: typeof x.note === "string" ? x.note : "",
      recordedByRole: typeof x.recordedByRole === "string" ? x.recordedByRole : "",
      billedInvoicePeriod:
        typeof x.billedInvoicePeriod === "string" && x.billedInvoicePeriod ? x.billedInvoicePeriod : null,
    };
  });
}
