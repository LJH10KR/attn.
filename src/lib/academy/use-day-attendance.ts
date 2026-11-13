"use client";

import {
  collection,
  collectionGroup,
  onSnapshot,
  query,
  where,
  type DocumentData,
  type Query,
} from "firebase/firestore";
import { useEffect, useState } from "react";
import type { DayArrival, DayClassRecord } from "@/lib/academy/day-roster";
import { compareStudentsByName, docToStudent, type StudentVM } from "@/lib/academy/student-row";
import { academyClassAttendancePath, academyStudentsPath, COLLECTIONS } from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";

/**
 * 3-A 날짜별 출결 읽기(★12 — 오늘·지난 날짜 모두 실시간 구독, 날짜 하나에 쿼리 3개).
 * - 등원 기록: `attendanceRecords` 컬렉션 그룹 `academyId ==` + `date ==`(규칙은 둘 다 있어야 허용, 출결·청구서 권한)
 * - 반 출결: `attendance where date ==`(출결·청구서 권한)
 * - 정정 이력: `attendanceCorrections where date ==`(출결 권한, 정렬은 화면에서)
 * 권한이 없으면 `enabled`를 거짓으로 — 규칙 거부 문서를 구독하지 않는다(2-I B1).
 */

const LOAD_ERROR = "출결 정보를 불러오지 못했습니다. 다시 시도해 주세요.";

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function millisOf(v: unknown): number | null {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === "function" ? t.toMillis() : null;
}

export function toDayArrival(d: DocumentData): DayArrival {
  return {
    status: d.status === "absent" ? "absent" : "present",
    reason: str(d.reason),
    note: str(d.note),
    arrivedAtMs: millisOf(d.arrivedAt),
    arrivedAtManual: d.arrivedAtManual === true,
    billed: typeof d.billedInvoicePeriod === "string" && d.billedInvoicePeriod.length > 0,
    corrected: d.correctedAt != null,
  };
}

function toDayClassRecord(d: DocumentData): DayClassRecord | null {
  if (typeof d.classId !== "string" || typeof d.studentId !== "string") return null;
  const slots = Array.isArray(d.slots)
    ? d.slots.flatMap((s: unknown) => {
        const x = s as { start?: unknown; end?: unknown };
        return typeof x?.start === "string" && typeof x?.end === "string" ? [{ start: x.start, end: x.end }] : [];
      })
    : [];
  return {
    classId: d.classId,
    studentId: d.studentId,
    status: d.status === "absent" ? "absent" : "present",
    className: str(d.className) ?? "반",
    slots,
    reason: str(d.reason),
    comment: str(d.comment),
    corrected: d.correctedAt != null,
    hasSessionDeduction: d.sessionDeduction != null,
  };
}

type Live<T> = { data: T; loaded: boolean; error: string | null };

function useLiveQuery<T>(
  key: string | null,
  build: () => Query<DocumentData>,
  map: (docs: DocumentData[]) => T,
  empty: T,
  retryToken: number,
): Live<T> {
  const [state, setState] = useState<Live<T> & { key: string | null }>({ key: null, data: empty, loaded: false, error: null });
  useEffect(() => {
    if (!key) return;
    return onSnapshot(
      build(),
      (snap) => setState({ key, data: map(snap.docs.map((d) => d.data())), loaded: true, error: null }),
      () => setState({ key, data: empty, loaded: true, error: LOAD_ERROR }),
    );
    // key가 조회 조건을 모두 담는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retryToken]);
  if (!key || state.key !== key) return { data: empty, loaded: false, error: null };
  return { data: state.data, loaded: state.loaded, error: state.error };
}

const EMPTY_ARRIVALS: ReadonlyMap<string, DayArrival> = new Map();
const EMPTY_LIST: never[] = [];

/** 그날 학원 전체 등원 기록(학생 id → 기록) */
export function useDayArrivals(academyId: string, date: string, enabled: boolean, retryToken = 0) {
  return useLiveQuery<ReadonlyMap<string, DayArrival>>(
    enabled ? `${academyId}|${date}` : null,
    () =>
      query(
        collectionGroup(getFirebaseDb(), "attendanceRecords"),
        where("academyId", "==", academyId),
        where("date", "==", date),
      ),
    (docs) => {
      const m = new Map<string, DayArrival>();
      for (const d of docs) if (typeof d.studentId === "string") m.set(d.studentId, toDayArrival(d));
      return m;
    },
    EMPTY_ARRIVALS,
    retryToken,
  );
}

/** 그날 학원 전체 반 출결 */
export function useDayClassRecords(academyId: string, date: string, enabled: boolean, retryToken = 0) {
  return useLiveQuery<DayClassRecord[]>(
    enabled ? `${academyId}|${date}` : null,
    () => query(collection(getFirebaseDb(), academyClassAttendancePath(academyId)), where("date", "==", date)),
    (docs) => docs.flatMap((d) => toDayClassRecord(d) ?? []),
    EMPTY_LIST,
    retryToken,
  );
}

/** 정정 이력 한 건(화면 표시용) */
export type AttendanceCorrectionRow = {
  studentId: string;
  studentName: string;
  classId: string | null;
  className: string | null;
  layer: "arrival" | "class";
  action: "create" | "update" | "delete" | "detail";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  byName: string;
  atMs: number;
};

/** 그날 정정 이력(최근 먼저) */
export function useDayCorrections(academyId: string, date: string, enabled: boolean, retryToken = 0) {
  return useLiveQuery<AttendanceCorrectionRow[]>(
    enabled ? `${academyId}|${date}` : null,
    () =>
      query(
        collection(getFirebaseDb(), COLLECTIONS.academies, academyId, "attendanceCorrections"),
        where("date", "==", date),
      ),
    (docs) =>
      docs
        .map((d) => ({
          studentId: String(d.studentId ?? ""),
          studentName: str(d.studentName) ?? "학생",
          classId: str(d.classId),
          className: str(d.className),
          layer: d.layer === "class" ? ("class" as const) : ("arrival" as const),
          action: (["create", "update", "delete", "detail"].includes(d.action) ? d.action : "update") as AttendanceCorrectionRow["action"],
          before: d.before && typeof d.before === "object" ? (d.before as Record<string, unknown>) : null,
          after: d.after && typeof d.after === "object" ? (d.after as Record<string, unknown>) : null,
          byName: str(d.byName) ?? "",
          atMs: millisOf(d.at) ?? Date.now(),
        }))
        .sort((a, b) => b.atMs - a.atMs),
    EMPTY_LIST,
    retryToken,
  );
}

/** 학원 원생 목록 실시간(원장 출결 화면 — 학생 읽기 권한이 있을 때만, 문서 id가 필요해 따로 둔다) */
export function useAcademyStudentList(academyId: string, enabled: boolean, retryToken = 0): Live<StudentVM[]> {
  const [state, setState] = useState<Live<StudentVM[]> & { key: string | null }>({
    key: null, data: [], loaded: false, error: null,
  });
  const key = enabled ? academyId : null;
  useEffect(() => {
    if (!key) return;
    return onSnapshot(
      collection(getFirebaseDb(), academyStudentsPath(key)),
      (snap) => {
        const list = snap.docs.map((d) => docToStudent(d.id, d.data() as Record<string, unknown>));
        list.sort(compareStudentsByName);
        setState({ key, data: list, loaded: true, error: null });
      },
      () => setState({ key, data: [], loaded: true, error: "원생 목록을 불러오지 못했습니다. 다시 시도해 주세요." }),
    );
  }, [key, retryToken]);
  if (!key || state.key !== key) return { data: [], loaded: false, error: null };
  return { data: state.data, loaded: state.loaded, error: state.error };
}
