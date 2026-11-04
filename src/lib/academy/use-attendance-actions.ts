"use client";

import { httpsCallable } from "firebase/functions";
import { useCallback, useState } from "react";
import {
  attendanceActionErrorMessage,
  attendanceActionMessage,
  type AttendanceActionResult,
} from "@/lib/academy/attendance-records";
import {
  ARRIVAL_STATUS_LABELS,
  CLASS_STATUS_LABELS,
  type AttendanceStatus,
} from "@/lib/academy/attendance-rules";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";

export type ArrivalVia = "teacher_my_classes" | "student_list" | "student_detail" | "class_detail";
export type ClassVia = "teacher_my_classes" | "class_detail";

/**
 * 등원·반 출결 버튼 호출(2-I) — 한 번에 하나만 처리, 결과는 `onDone(message, ok, result)`로 화면에 넘긴다.
 * `busyKey`: `${studentId}:${classId|"arrival"}:${status|"arrive"}`
 */
export function useAttendanceActions(
  academyId: string | null,
  onDone: (message: string, ok: boolean, studentId: string, result: AttendanceActionResult | null) => void,
) {
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const markArrival = useCallback(
    async (studentId: string, status: AttendanceStatus, via: ArrivalVia, studentName?: string) => {
      if (!academyId) return;
      setBusyKey(`${studentId}:arrival:${status}`);
      const label = ARRIVAL_STATUS_LABELS[status];
      const who = studentName ? `${studentName} ` : "";
      try {
        const res = await httpsCallable(getFirebaseFunctions(), "recordStudentArrival")({
          academyId,
          studentId,
          status,
          via,
        });
        const data = res.data as AttendanceActionResult;
        onDone(`${who}${attendanceActionMessage(label, data)}`, true, studentId, data);
      } catch (e) {
        onDone(attendanceActionErrorMessage(e), false, studentId, null);
      } finally {
        setBusyKey(null);
      }
    },
    [academyId, onDone],
  );

  const markClass = useCallback(
    async (
      classId: string,
      className: string,
      studentId: string,
      status: AttendanceStatus,
      via: ClassVia,
      studentName?: string,
    ) => {
      if (!academyId) return;
      setBusyKey(`${studentId}:${classId}:${status}`);
      const label = `${className} ${CLASS_STATUS_LABELS[status]}`;
      const who = studentName ? `${studentName} ` : "";
      try {
        const res = await httpsCallable(getFirebaseFunctions(), "recordClassAttendance")({
          academyId,
          classId,
          studentId,
          status,
          via,
        });
        const data = res.data as AttendanceActionResult;
        onDone(`${who}${attendanceActionMessage(label, data)}`, true, studentId, data);
      } catch (e) {
        onDone(attendanceActionErrorMessage(e), false, studentId, null);
      } finally {
        setBusyKey(null);
      }
    },
    [academyId, onDone],
  );

  return { busyKey, markArrival, markClass };
}

/** `useAttendanceActions().busyKey`(`학생:반|arrival:상태`) → 이 줄의 처리 중 버튼 */
export function rowBusyFor(
  busyKey: string | null,
  studentId: string,
  classId: string,
): "present" | "absent" | "arrive" | null {
  if (!busyKey) return null;
  if (busyKey.startsWith(`${studentId}:arrival:`)) return "arrive";
  if (busyKey === `${studentId}:${classId}:present`) return "present";
  if (busyKey === `${studentId}:${classId}:absent`) return "absent";
  return null;
}
