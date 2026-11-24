"use client";

import { FirebaseError } from "firebase/app";
import { collection, doc, onSnapshot, query, where } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import {
  classStatusOf,
  seoulDateString,
  seoulWeekday,
  type ArrivalSnapshot,
  type ClassStatus,
} from "@/lib/academy/attendance-rules";
import {
  academyClassAttendancePath,
  academyClassCancellationsPath,
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

/**
 * 학생 한 명의 오늘 등원 기록 — undefined = 읽는 중. `reason`은 미등원 사유(2-J 취소 판단).
 * 3-B: 하원(`departed`·`leftAtMs`, H3 — 하원이 있으면 미등원·등원 취소 거부).
 */
export type TodayArrival =
  | (NonNullable<ArrivalSnapshot> & {
      arrivedAtMs: number | null;
      reason: string | null;
      departed: boolean;
      leftAtMs: number | null;
    })
  | null;

function millisOf(v: unknown): number | null {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === "function" ? t.toMillis() : null;
}

function toTodayArrival(snap: { exists: () => boolean; data: () => Record<string, unknown> | undefined }): TodayArrival {
  if (!snap.exists()) return null;
  const d = snap.data() ?? {};
  const departed = d.departed === true;
  return {
    status: d.status === "absent" ? "absent" : "present",
    billed: typeof d.billedInvoicePeriod === "string" && d.billedInvoicePeriod.length > 0,
    arrivedAtMs: millisOf(d.arrivedAt),
    reason: typeof d.reason === "string" ? d.reason : null,
    departed,
    leftAtMs: departed ? millisOf(d.leftAt) : null,
  };
}

export type ClassTodayAttendance = {
  /** 학생 id → 오늘 등원 기록(undefined = 아직 못 읽음) */
  arrivals: ReadonlyMap<string, TodayArrival>;
  /** 학생 id → 이 반 오늘 출결(3-B 지각 포함) */
  records: ReadonlyMap<string, ClassStatus>;
  /** 학생 id → 지각 분(지각 기록만) */
  lateMinutes: ReadonlyMap<string, number>;
  recordsLoaded: boolean;
  /** 3-B 이 반 오늘 휴강 — undefined = 읽는 중 */
  cancelled: boolean | undefined;
  /** 구독 오류(권한을 잃음·네트워크) — 버튼은 옅게 */
  error: string | null;
};

const LOAD_ERROR = "출결 상태를 불러오지 못했습니다. 화면을 새로고침해 주세요.";

/**
 * 3-A B2 — 반에서 빠진 선생님은 그 반 출결·학생 등원 구독이 permission-denied를 받는다. 목록 갱신(반·학생이 사라져
 * 이 구독이 끝남)과 오류의 도착 순서가 정해져 있지 않으므로, 권한 오류는 잠시 기다렸다가 그때도 구독이 살아 있을 때만
 * 보여 준다(사라질 반·학생이면 cleanup이 타이머를 지워 조용히 정리). 그 밖의 오류는 바로 보여 준다.
 */
const PERMISSION_ERROR_GRACE_MS = 2500;

function deferredErrorReporter(report: () => void): { onError: (e: unknown) => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  return {
    onError: (e) => {
      if (disposed) return;
      if (e instanceof FirebaseError && e.code === "permission-denied") {
        if (!timer) timer = setTimeout(() => !disposed && report(), PERMISSION_ERROR_GRACE_MS);
        return;
      }
      report();
    },
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

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
  const [records, setRecords] = useState<Map<string, ClassStatus>>(() => new Map());
  const [lateMinutes, setLateMinutes] = useState<Map<string, number>>(() => new Map());
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [cancelled, setCancelled] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setArrivals(new Map());
    setError(null);
    if (!enabled || !idsKey) return;
    const db = getFirebaseDb();
    const errors = deferredErrorReporter(() => setError(LOAD_ERROR));
    const unsubs = idsKey.split("|").map((studentId) =>
      onSnapshot(
        doc(db, academyStudentAttendanceRecordsPath(academyId, studentId), date),
        (snap) => {
          setArrivals((prev) => new Map(prev).set(studentId, toTodayArrival(snap)));
        },
        errors.onError,
      ),
    );
    return () => {
      errors.dispose();
      unsubs.forEach((u) => u());
    };
  }, [academyId, date, enabled, idsKey]);

  useEffect(() => {
    setRecords(new Map());
    setLateMinutes(new Map());
    setRecordsLoaded(false);
    if (!enabled) return;
    const q = query(
      collection(getFirebaseDb(), academyClassAttendancePath(academyId)),
      where("classId", "==", classId),
      where("date", "==", date),
    );
    const errors = deferredErrorReporter(() => setError(LOAD_ERROR));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const next = new Map<string, ClassStatus>();
        const minutes = new Map<string, number>();
        snap.docs.forEach((d) => {
          const sid = d.get("studentId");
          if (typeof sid !== "string") return;
          const status = classStatusOf(d.get("status"));
          next.set(sid, status);
          const m = d.get("lateMinutes");
          if (status === "late" && typeof m === "number") minutes.set(sid, m);
        });
        setRecords(next);
        setLateMinutes(minutes);
        setRecordsLoaded(true);
      },
      errors.onError,
    );
    return () => {
      errors.dispose();
      unsub();
    };
  }, [academyId, classId, date, enabled]);

  // 3-B ★15 휴강 — 담당 선생님은 없는 문서를 단건으로 못 읽어(규칙) `classId ==`·`date ==` 목록으로 본다.
  // P3: 반에서 빠진 선생님의 permission-denied는 반 출결과 같은 2.5초 유예·조용히 정리.
  useEffect(() => {
    setCancelled(undefined);
    if (!enabled) return;
    const q = query(
      collection(getFirebaseDb(), academyClassCancellationsPath(academyId)),
      where("classId", "==", classId),
      where("date", "==", date),
    );
    const errors = deferredErrorReporter(() => setError(LOAD_ERROR));
    const unsub = onSnapshot(q, (snap) => setCancelled(!snap.empty), errors.onError);
    return () => {
      errors.dispose();
      unsub();
    };
  }, [academyId, classId, date, enabled]);

  return { arrivals, records, lateMinutes, recordsLoaded, cancelled, error };
}

/** 그날 이 학생의 반 출결 한 건 */
export type StudentClassRecord = { classId: string; className: string; status: ClassStatus };

/**
 * 학생 한 명의 오늘 등원 기록(+ 그날 반 출결) 구독 — 학생 상세 시트 "오늘" 줄(2-J 등원 취소).
 * `enabled`는 등원 처리 권한(`canMarkArrival`, 규칙의 등원 기록 읽기에 포함됨)일 때만.
 * `withClassRecords`는 출결·청구서 권한일 때만 — 권한 없는 담당 선생님은 다른 반 기록이 섞인
 * `studentId ==` 목록을 규칙상 읽을 수 없어 미리 세지 않는다(서버 문구로 안내).
 */
export function useStudentTodayArrival(params: {
  academyId: string;
  studentId: string;
  date: string;
  enabled: boolean;
  withClassRecords: boolean;
}): {
  arrival: TodayArrival | undefined;
  /** null = 읽지 않음(권한 없음·읽는 중·구독 실패) */
  classRecords: StudentClassRecord[] | null;
  /** `withClassRecords`인데 그날 반 출결을 아직 읽는 중 — 취소 버튼을 잠시 막는다(실패하면 false로 돌아감) */
  classRecordsLoading: boolean;
  /** 등원 기록 구독 오류 — "오늘" 줄을 숨긴다 */
  error: boolean;
} {
  const { academyId, studentId, date, enabled, withClassRecords } = params;
  const [arrival, setArrival] = useState<TodayArrival | undefined>(undefined);
  const [classRecords, setClassRecords] = useState<StudentClassRecord[] | null>(null);
  const [classRecordsLoading, setClassRecordsLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setArrival(undefined);
    setError(false);
    if (!enabled) return;
    return onSnapshot(
      doc(getFirebaseDb(), academyStudentAttendanceRecordsPath(academyId, studentId), date),
      (snap) => setArrival(toTodayArrival(snap)),
      () => setError(true),
    );
  }, [academyId, studentId, date, enabled]);

  useEffect(() => {
    setClassRecords(null);
    setClassRecordsLoading(enabled && withClassRecords);
    if (!enabled || !withClassRecords) return;
    const q = query(
      collection(getFirebaseDb(), academyClassAttendancePath(academyId)),
      where("studentId", "==", studentId),
      where("date", "==", date),
    );
    return onSnapshot(
      q,
      (snap) => {
        setClassRecords(
          snap.docs.map((d) => ({
            classId: String(d.get("classId") ?? ""),
            className: typeof d.get("className") === "string" && d.get("className") ? d.get("className") : "반",
            status: classStatusOf(d.get("status")),
          })),
        );
        setClassRecordsLoading(false);
      },
      // 실패하면 미리 세지 않고 버튼을 다시 열어 둔다 — 반 출결이 있으면 서버가 문구로 거부
      () => {
        setClassRecords(null);
        setClassRecordsLoading(false);
      },
    );
  }, [academyId, studentId, date, enabled, withClassRecords]);

  return { arrival, classRecords, classRecordsLoading, error };
}
