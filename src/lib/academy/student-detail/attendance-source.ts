import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import {
  academyClassAttendancePath,
  academyStudentAttendanceRecordsPath,
  isAbsenceReason,
  type AbsenceReason,
} from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";

/**
 * 학생 상세 출결 탭의 데이터 출처(2-I) — 등원 기록(학생 하위 `attendanceRecords`, 날짜당 1건)과
 * 반 출결(`attendance`, 날짜 × 반, `studentId ==` + 날짜 범위 — 인덱스 studentId ASC·date DESC).
 * 읽기 권한: `lessons.attendance`·`billing.invoices`(규칙, 출결 탭과 같음).
 */

/** 등원 기록 한 건(present = 등원, absent = 미등원) */
export type StudentAttendanceRow = {
  /** 서울 기준 YYYY-MM-DD */
  date: string;
  status: "present" | "absent";
  reason: AbsenceReason | null;
  note: string;
  recordedByRole: string;
  /** 결석 차감이 반영된 청구서(YYYY-MM) — 있으면 수정·삭제 잠금 */
  billedInvoicePeriod: string | null;
  /** 등원 시각(2-I 이후 기록만) */
  arrivedAtMs: number | null;
};

/** 반 출결 한 건 */
export type StudentClassAttendanceRow = {
  date: string;
  classId: string;
  className: string;
  status: "present" | "absent";
  slots: { start: string; end: string }[];
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
      arrivedAtMs: x.arrivedAt && typeof x.arrivedAt.toMillis === "function" ? x.arrivedAt.toMillis() : null,
    };
  });
}

/** `from`~`to` 반 출결, 최근 날짜부터(같은 날은 반 이름순) */
export async function loadStudentClassAttendance(
  academyId: string,
  studentId: string,
  range: { from: string; to: string },
): Promise<StudentClassAttendanceRow[]> {
  const snap = await getDocs(
    query(
      collection(getFirebaseDb(), academyClassAttendancePath(academyId)),
      where("studentId", "==", studentId),
      where("date", ">=", range.from),
      where("date", "<=", range.to),
      orderBy("date", "desc"),
    ),
  );
  return snap.docs
    .map((d) => {
      const x = d.data();
      const slots = Array.isArray(x.slots)
        ? x.slots.flatMap((s: unknown) => {
            const o = s as { start?: unknown; end?: unknown } | null;
            return o && typeof o.start === "string" && typeof o.end === "string" ? [{ start: o.start, end: o.end }] : [];
          })
        : [];
      return {
        date: typeof x.date === "string" ? x.date : "",
        classId: typeof x.classId === "string" ? x.classId : "",
        className: typeof x.className === "string" && x.className ? x.className : "반",
        status: x.status === "absent" ? ("absent" as const) : ("present" as const),
        slots,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.className.localeCompare(b.className, "ko"));
}
