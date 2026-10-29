"use client";

import { doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useState } from "react";
import {
  academyOptionsPath,
  type AcademyOptionItem,
  type AcademyOptionListKind,
} from "@/lib/firebase/attn-schema";
import { getFirebaseDb, getFirebaseFunctions } from "@/lib/firebase/client-app";

function readItems(raw: unknown): AcademyOptionItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const id = (x as { id?: unknown })?.id;
    const label = (x as { label?: unknown })?.label;
    return typeof id === "string" && typeof label === "string" ? [{ id, label }] : [];
  });
}

/**
 * 학원 선택지 목록(직무 등) 실시간 구독 + 저장.
 * 저장은 목록 전체를 보내며(id 없는 항목은 서버가 발급) 서버가 종류별 권한을 검사한다.
 */
export function useAcademyOptionList(academyId: string | null, kind: AcademyOptionListKind) {
  const [items, setItems] = useState<AcademyOptionItem[]>([]);
  const [loading, setLoading] = useState(Boolean(academyId));

  useEffect(() => {
    if (!academyId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    return onSnapshot(
      doc(getFirebaseDb(), academyOptionsPath(academyId)),
      (snap) => {
        setItems(readItems(snap.get(kind)));
        setLoading(false);
      },
      () => {
        setItems([]);
        setLoading(false);
      },
    );
  }, [academyId, kind]);

  const save = useCallback(
    async (next: { id?: string; label: string }[]): Promise<AcademyOptionItem[]> => {
      if (!academyId) return [];
      const fn = httpsCallable(getFirebaseFunctions(), "saveAcademyOptionList");
      const res = await fn({ academyId, kind, items: next });
      const saved = readItems((res.data as { items?: unknown }).items);
      setItems(saved);
      return saved;
    },
    [academyId, kind],
  );

  return { items, loading, save };
}
