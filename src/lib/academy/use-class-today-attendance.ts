"use client";

import { collection, doc, onSnapshot, query, where } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { seoulDateString, seoulWeekday, type ArrivalSnapshot } from "@/lib/academy/attendance-rules";
import {
  academyClassAttendancePath,
  academyStudentAttendanceRecordsPath,
} from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";

/** 서울 기준 오늘 날짜·요일 — 1분마다 확인해 자정이 지나면 바뀐다 */
export function useSeoulToday(): { date: string; weekday: number } {
  const [today, setToday] = useState(() => ({ date: seoulDateString(), weekday: seoulWeekday() }));
  useEffect(() => {
    const id = window.setInterval(() => {
      const date = seoulDateString();
      setToday((prev) => (prev.date === date ? prev : { date, weekday: seoulWeekday() }));
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);
  return today;
}

/** 학생 한 명의 오늘 등원 기록 — undefined = 읽는 중 */
export type TodayArrival = (NonNullable<ArrivalSnapshot> & { arrivedAtMs: number | null }) | null;

export type ClassTodayAttendance = {
  /** 학생 id → 오늘 등원 기록(undefined = 아직 못 읽음) */
  arrivals: ReadonlyMap<string, TodayArrival>;
  /** 학생 id → 이 반 오늘 출결 */
  records: ReadonlyMap<string, "present" | "absent">;
  recordsLoaded: boolean;
  /** 구독 오류(권한을 잃음·네트워크) — 버튼은 옅게 */
  error: string | null;
};

const LOAD_ERROR = "출결 상태를 불러오지 못했습니다. 화면을 새로고침해 주세요.";

/**
 * 반 하나의 오늘 출결 실시간 구독(2-I) — 학생별 등원 문서 + 반 출결 `classId == && date ==` 목록.
 * **읽기 권한이 있을 때만 켠다(B1)**: `enabled`는 `studentAccess.readClassAttendance(cls)`,
 * `arrivalStudentIds`는 등원 기록을 읽을 수 있는 학생만(출결·청구서 권한이면 모두, 아니면 학생 teacherUids에 본인).
 * 규칙이 거부하는 문서를 구독하면 Firestore SDK가 내부 오류로 멈출 수 있어(2-F) 호출하는 쪽이 걸러서 넘긴다.
 */
export function useClassTodayAttendance(params: {
  academyId: string;
  classId: string;
  date: string;
  enabled: boolean;
  arrivalStudentIds: readonly string[];
}): ClassTodayAttendance {
  const { academyId, classId, date, enabled } = params;
  const idsKey = useMemo(() => [...new Set(params.arrivalStudentIds)].sort().join("|"), [params.arrivalStudentIds]);
  const [arrivals, setArrivals] = useState<Map<string, TodayArrival>>(() => new Map());
  const [records, setRecords] = useState<Map<string, "present" | "absent">>(() => new Map());
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setArrivals(new Map());
    setError(null);
    if (!enabled || !idsKey) return;
    const db = getFirebaseDb();
    const unsubs = idsKey.split("|").map((studentId) =>
      onSnapshot(
        doc(db, academyStudentAttendanceRecordsPath(academyId, studentId), date),
        (snap) => {
          const d = snap.data();
          const value: TodayArrival = snap.exists()
            ? {
                status: d?.status === "absent" ? "absent" : "present",
                billed: typeof d?.billedInvoicePeriod === "string" && d.billedInvoicePeriod.length > 0,
                arrivedAtMs:
                  d?.arrivedAt && typeof d.arrivedAt.toMillis === "function" ? d.arrivedAt.toMillis() : null,
              }
            : null;
          setArrivals((prev) => new Map(prev).set(studentId, value));
        },
        () => setError(LOAD_ERROR),
      ),
    );
    return () => unsubs.forEach((u) => u());
  }, [academyId, date, enabled, idsKey]);

  useEffect(() => {
    setRecords(new Map());
    setRecordsLoaded(false);
    if (!enabled) return;
    const q = query(
      collection(getFirebaseDb(), academyClassAttendancePath(academyId)),
      where("classId", "==", classId),
      where("date", "==", date),
    );
    return onSnapshot(
      q,
      (snap) => {
        const next = new Map<string, "present" | "absent">();
        snap.docs.forEach((d) => {
          const sid = d.get("studentId");
          if (typeof sid === "string") next.set(sid, d.get("status") === "absent" ? "absent" : "present");
        });
        setRecords(next);
        setRecordsLoaded(true);
      },
      () => setError(LOAD_ERROR),
    );
  }, [academyId, classId, date, enabled]);

  return { arrivals, records, recordsLoaded, error };
}
