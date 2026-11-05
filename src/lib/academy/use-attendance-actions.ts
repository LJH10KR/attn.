"use client";

import { httpsCallable } from "firebase/functions";
import { useCallback, useState } from "react";
import {
  attendanceActionErrorMessage,
  attendanceActionMessage,
  attendanceCancelMessage,
  type AttendanceActionResult,
  type AttendanceCancelResult,
} from "@/lib/academy/attendance-records";
import {
  ARRIVAL_STATUS_LABELS,
  CLASS_STATUS_LABELS,
  type AttendanceStatus,
} from "@/lib/academy/attendance-rules";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";

export type ArrivalVia = "teacher_my_classes" | "student_list" | "student_detail" | "class_detail";
export type ClassVia = "teacher_my_classes" | "class_detail";
/** 등원 취소 경로(2-J) */
export type ArrivalCancelVia = "teacher_my_classes" | "student_detail";

/**
 * 등원·반 출결 버튼 호출(2-I) — 한 번에 하나만 처리, 결과는 `onDone(message, ok, result)`로 화면에 넘긴다.
 * `busyKey`: `${studentId}:${classId|"arrival"}:${status|"arrive"|"cancel"}`
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

  /**
   * 반 출석·결석 취소(2-J) — 확인 창이 부른다. 성공하면 `onDone`으로 결과 문구를 넘기고 null,
   * 실패하면 확인 창 안에 보여 줄 문구를 돌려준다(창은 열린 채).
   */
  const cancelClass = useCallback(
    async (params: {
      classId: string;
      className: string;
      studentId: string;
      status: AttendanceStatus;
      date: string;
      via: ClassVia;
      studentName?: string;
    }): Promise<string | null> => {
      if (!academyId) return "학원 정보를 찾을 수 없습니다.";
      const { classId, className, studentId, status, date, via, studentName } = params;
      setBusyKey(`${studentId}:${classId}:cancel`);
      const who = studentName ? `${studentName} ` : "";
      try {
        const res = await httpsCallable(getFirebaseFunctions(), "cancelClassAttendance")({
          academyId,
          classId,
          studentId,
          date,
          via,
        });
        const data = res.data as AttendanceCancelResult;
        const label = `${className} ${CLASS_STATUS_LABELS[data.cancelled ?? status]}`;
        onDone(`${who}${attendanceCancelMessage(label, data)}`, true, studentId, null);
        return null;
      } catch (e) {
        return attendanceActionErrorMessage(e, CANCEL_FALLBACK);
      } finally {
        setBusyKey(null);
      }
    },
    [academyId, onDone],
  );

  /** 등원·미등원 기록 취소(2-J) — `cancelClass`와 같은 방식 */
  const cancelArrival = useCallback(
    async (params: {
      studentId: string;
      status: AttendanceStatus;
      date: string;
      via: ArrivalCancelVia;
      studentName?: string;
    }): Promise<string | null> => {
      if (!academyId) return "학원 정보를 찾을 수 없습니다.";
      const { studentId, status, date, via, studentName } = params;
      setBusyKey(`${studentId}:arrival:cancel`);
      const who = studentName ? `${studentName} ` : "";
      try {
        const res = await httpsCallable(getFirebaseFunctions(), "cancelStudentArrival")({
          academyId,
          studentId,
          date,
          via,
        });
        const data = res.data as AttendanceCancelResult;
        const label = ARRIVAL_STATUS_LABELS[data.cancelled ?? status];
        onDone(`${who}${attendanceCancelMessage(label, data)}`, true, studentId, null);
        return null;
      } catch (e) {
        return attendanceActionErrorMessage(e, CANCEL_FALLBACK);
      } finally {
        setBusyKey(null);
      }
    },
    [academyId, onDone],
  );

  return { busyKey, markArrival, markClass, cancelClass, cancelArrival };
}

const CANCEL_FALLBACK = "기록을 취소하지 못했습니다. 잠시 후 다시 시도해 주세요.";

/** `useAttendanceActions().busyKey`(`학생:반|arrival:상태`) → 이 줄의 처리 중 버튼 */
export function rowBusyFor(
  busyKey: string | null,
  studentId: string,
  classId: string,
): "present" | "absent" | "arrive" | "cancel" | null {
  if (!busyKey) return null;
  if (busyKey === `${studentId}:arrival:cancel`) return "cancel";
  if (busyKey.startsWith(`${studentId}:arrival:`)) return "arrive";
  if (busyKey === `${studentId}:${classId}:cancel`) return "cancel";
  if (busyKey === `${studentId}:${classId}:present`) return "present";
  if (busyKey === `${studentId}:${classId}:absent`) return "absent";
  return null;
}
