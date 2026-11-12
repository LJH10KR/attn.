"use client";

import { doc, getDoc } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebaseDb } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import {
  EMPTY_LEGAL_INFO,
  LEGAL_INFO_DOC_PATH,
  normalizeLegalInfo,
  type LegalInfo,
  type LegalInfoStatus,
} from "@/lib/legal/legal-info";

/** 읽기를 오래 기다리지 않는다(오프라인이면 SDK가 늦게 실패) — 그동안에도 본문은 보인다 */
const READ_TIMEOUT_MS = 8000;

let cached: LegalInfo | null = null;
let inflight: Promise<LegalInfo> | null = null;
const listeners = new Set<(info: LegalInfo) => void>();

/**
 * 법적 고지 정보 읽기(2-O) — `appConfig/legalInfo` 1건. 같은 페이지 안에서는 한 번만 읽고 나눠 쓴다
 * (본문과 하단이 함께 있어도 1건). 실패는 캐시하지 않는다(다음 화면에서 다시 시도).
 */
export function loadLegalInfo(): Promise<LegalInfo> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = (async () => {
      if (!isFirebaseConfigured()) throw new Error("firebase-not-configured");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("legal-info-timeout")), READ_TIMEOUT_MS);
      });
      try {
        const snap = await Promise.race([getDoc(doc(getFirebaseDb(), ...LEGAL_INFO_DOC_PATH)), timeout]);
        return normalizeLegalInfo(snap.exists() ? snap.data() : null);
      } finally {
        clearTimeout(timer);
      }
    })()
      .then((info) => {
        cached = info;
        return info;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** 관리자 저장 뒤 — 같은 페이지의 표시도 바로 바꾼다 */
export function setLegalInfoCache(info: LegalInfo): void {
  cached = info;
  for (const l of listeners) l(info);
}

/**
 * 처리방침·약관·하단이 쓰는 훅. 처음(서버 렌더 포함)은 "loading" — 읽기에 실패하면 "error"(빈 값으로 표시).
 */
export function useLegalInfo(): { info: LegalInfo; status: LegalInfoStatus } {
  const [state, setState] = useState<{ info: LegalInfo; status: LegalInfoStatus }>({
    info: EMPTY_LEGAL_INFO,
    status: "loading",
  });

  useEffect(() => {
    let alive = true;
    const onInfo = (info: LegalInfo) => {
      if (alive) setState({ info, status: "ready" });
    };
    listeners.add(onInfo);
    loadLegalInfo().then(onInfo, () => {
      if (alive) setState({ info: EMPTY_LEGAL_INFO, status: "error" });
    });
    return () => {
      alive = false;
      listeners.delete(onInfo);
    };
  }, []);

  return state;
}
