"use client";

import { collection, onSnapshot } from "firebase/firestore";
import { useCallback, useEffect, useState } from "react";
import type { AcademyClassScheduleSlot, AcademyClassStatus } from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";

/** 반 요약 — 원생 화면·학생 상세 시트·반 관리 화면이 같이 쓴다 */
export type AcademyClassBrief = {
  id: string;
  name: string;
  status: AcademyClassStatus;
  sortOrder: number;
  /** 요일·시작 순(서버가 정렬해 저장) */
  schedule: AcademyClassScheduleSlot[];
  teacherUids: string[];
  roomId: string | null;
  capacity: number | null;
};

function readStatus(raw: unknown): AcademyClassStatus {
  return raw === "preparing" || raw === "ended" ? raw : "active";
}

function readSchedule(raw: unknown): AcademyClassScheduleSlot[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const s = x as Record<string, unknown> | null;
    return s && typeof s.weekday === "number" && typeof s.start === "string" && typeof s.end === "string"
      ? [{ weekday: s.weekday, start: s.start, end: s.end }]
      : [];
  });
}

/** 반 문서 → 요약(반 관리 화면·선생님 화면 공용) */
export function docToClassBrief(id: string, data: Record<string, unknown>): AcademyClassBrief {
  return {
    id,
    name: typeof data.name === "string" ? data.name : "",
    status: readStatus(data.status),
    sortOrder: typeof data.sortOrder === "number" ? data.sortOrder : 0,
    schedule: readSchedule(data.schedule),
    teacherUids: Array.isArray(data.teacherUids)
      ? data.teacherUids.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [],
    roomId: typeof data.roomId === "string" && data.roomId ? data.roomId : null,
    capacity: typeof data.capacity === "number" ? data.capacity : null,
  };
}

export function compareClassesByOrder(a: AcademyClassBrief, b: AcademyClassBrief): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ko");
}

/**
 * 학원 반 목록 실시간 구독(정렬 순서대로). 반 읽기는 원장·활성 직원(규칙) — `enabled`가 거짓이면 읽지 않는다.
 * 읽기 오류는 `error`로 알린다(원생 화면은 빈 목록처럼 써도 되고, 반 관리 화면은 오류·다시 시도를 보여 준다).
 */
export function useAcademyClasses(academyId: string | null, enabled = true) {
  const [classes, setClasses] = useState<AcademyClassBrief[]>([]);
  const [loading, setLoading] = useState(Boolean(academyId && enabled));
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!academyId || !enabled) {
      setClasses([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    return onSnapshot(
      collection(getFirebaseDb(), "academies", academyId, "classes"),
      (snap) => {
        const list = snap.docs.map((d) => docToClassBrief(d.id, d.data() as Record<string, unknown>));
        list.sort(compareClassesByOrder);
        setClasses(list);
        setError(null);
        setLoading(false);
      },
      () => {
        setClasses([]);
        setError("반 목록을 불러오지 못했습니다.");
        setLoading(false);
      },
    );
  }, [academyId, enabled, reloadKey]);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  return { classes, loading, error, retry };
}
