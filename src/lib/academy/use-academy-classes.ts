"use client";

import { collection, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import type { AcademyClassStatus } from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";

/** 원생 화면이 쓰는 반 요약 — 반 관리 화면(2-F)에서 필드를 늘린다 */
export type AcademyClassBrief = {
  id: string;
  name: string;
  status: AcademyClassStatus;
  sortOrder: number;
};

function readStatus(raw: unknown): AcademyClassStatus {
  return raw === "preparing" || raw === "ended" ? raw : "active";
}

/**
 * 학원 반 목록 실시간 구독(정렬 순서대로). 반 읽기는 원장·활성 직원(규칙) — `enabled`가 거짓이면 읽지 않는다.
 */
export function useAcademyClasses(academyId: string | null, enabled = true) {
  const [classes, setClasses] = useState<AcademyClassBrief[]>([]);
  const [loading, setLoading] = useState(Boolean(academyId && enabled));

  useEffect(() => {
    if (!academyId || !enabled) {
      setClasses([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    return onSnapshot(
      collection(getFirebaseDb(), "academies", academyId, "classes"),
      (snap) => {
        const list = snap.docs.map((d) => ({
          id: d.id,
          name: typeof d.get("name") === "string" ? (d.get("name") as string) : "",
          status: readStatus(d.get("status")),
          sortOrder: typeof d.get("sortOrder") === "number" ? (d.get("sortOrder") as number) : 0,
        }));
        list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ko"));
        setClasses(list);
        setLoading(false);
      },
      () => {
        setClasses([]);
        setLoading(false);
      },
    );
  }, [academyId, enabled]);

  return { classes, loading };
}
