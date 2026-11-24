"use client";

import { httpsCallable } from "firebase/functions";
import { useCallback, useState } from "react";
import { attendanceActionErrorMessage, type AttendanceNotifyResult } from "@/lib/academy/attendance-records";
import type { AbsenceReason, AttendanceStatus, ClassStatus } from "@/lib/academy/attendance-rules";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";

/**
 * 3-A 지난 날짜 정정·사유와 코멘트·일괄 처리 호출 — 원장·출결 권한 화면(원장 출결 화면·학생 상세 출결 탭).
 * 지난 날짜 정정은 학부모 알림이 없고 정정 이력이 남는다(서버). 실패 문구는 서버 문구 그대로.
 */

export type CorrectionVia = "attendance_screen" | "student_detail";

export type CallOutcome = { ok: true; changed: boolean } | { ok: false; message: string };

export type BatchAction = "arrive" | "depart" | "class_present" | "class_absent";
export type BatchMode = "today" | "past";
export type BatchRowResult = {
  studentId: string;
  result: "changed" | "unchanged" | "blocked";
  message?: string;
  notification?: AttendanceNotifyResult;
};
export type BatchResult =
  | {
      ok: true;
      mode: BatchMode;
      results: BatchRowResult[];
      counts: { changed: number; unchanged: number; blocked: number };
    }
  | { ok: false; message: string };

const FALLBACK = "처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";

export function useAttendanceCorrections(academyId: string) {
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const run = useCallback(
    async (key: string, name: string, payload: Record<string, unknown>): Promise<CallOutcome> => {
      setBusyKey(key);
      try {
        const res = await httpsCallable(getFirebaseFunctions(), name)({ academyId, ...payload });
        return { ok: true, changed: (res.data as { changed?: boolean }).changed !== false };
      } catch (e) {
        return { ok: false, message: attendanceActionErrorMessage(e, FALLBACK) };
      } finally {
        setBusyKey(null);
      }
    },
    [academyId],
  );

  /** 지난 날짜 등원 기록 — status null = 지우기, arrivedAtTime: "HH:mm"·null(지움)·undefined(그대로) */
  const correctArrival = useCallback(
    (p: {
      studentId: string;
      date: string;
      status: AttendanceStatus | null;
      reason?: AbsenceReason;
      arrivedAtTime?: string | null;
      via: CorrectionVia;
    }) => run(`${p.studentId}:arrival:correct`, "correctStudentArrival", p),
    [run],
  );

  /** 지난 날짜 반 출결 — status null = 지우기(미처리로), 3-B 지각은 `lateMinutes`(1~180) */
  const correctClass = useCallback(
    (p: {
      classId: string;
      studentId: string;
      date: string;
      status: ClassStatus | null;
      lateMinutes?: number;
      reason?: AbsenceReason;
      via: CorrectionVia;
    }) => run(`${p.studentId}:${p.classId}:correct`, "correctClassAttendance", p),
    [run],
  );

  /**
   * 3-B 하원 정정 — 지난 날짜 만들기·바꾸기·지우기(departed false), 오늘은 시각만(★7·R1 지금 이전).
   * leftAtTime: "HH:mm"·null(지움)·undefined(그대로)
   */
  const correctDeparture = useCallback(
    (p: { studentId: string; date: string; departed: boolean; leftAtTime?: string | null; via: CorrectionVia }) =>
      run(`${p.studentId}:departure:correct`, "correctStudentDeparture", p),
    [run],
  );

  /** 3-B 휴강 기록·메모 바꾸기·취소(알림 없음, 정정 기록) */
  const setCancellation = useCallback(
    (p: { classId: string; date: string; cancelled: boolean; memo?: string; via: "attendance_screen" }) =>
      run(`cancel:${p.classId}`, "setClassCancellation", p),
    [run],
  );

  /** 사유·메모(등원 기록)·코멘트(반 출결) — 날짜 상관없이, 알림 없음 */
  const updateDetails = useCallback(
    (p: {
      layer: "arrival" | "class";
      studentId: string;
      date: string;
      classId?: string;
      reason?: AbsenceReason;
      note?: string;
      via: CorrectionVia;
    }) => run(`${p.studentId}:${p.classId ?? "arrival"}:details`, "updateAttendanceDetails", p),
    [run],
  );

  /** 일괄 — 화면이 기대한 mode를 함께 보낸다(B1, 서버 판정과 다르면 전체 거부) */
  const runBatch = useCallback(
    async (p: {
      date: string;
      mode: BatchMode;
      classId: string;
      action: BatchAction;
      studentIds: string[];
    }): Promise<BatchResult> => {
      setBusyKey("batch");
      try {
        const res = await httpsCallable(getFirebaseFunctions(), "recordAttendanceBatch")({ academyId, ...p });
        const data = res.data as Omit<Extract<BatchResult, { ok: true }>, "ok">;
        return { ok: true, mode: data.mode, results: data.results, counts: data.counts };
      } catch (e) {
        return { ok: false, message: attendanceActionErrorMessage(e, FALLBACK) };
      } finally {
        setBusyKey(null);
      }
    },
    [academyId],
  );

  return { busyKey, correctArrival, correctClass, correctDeparture, setCancellation, updateDetails, runBatch };
}
