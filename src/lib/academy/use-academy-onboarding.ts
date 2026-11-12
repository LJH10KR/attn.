"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useState } from "react";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";

/**
 * 홈 "시작하기" 체크리스트(2-M) — 서버 `getAcademyOnboarding`·`updateAcademyOnboarding`(원장만) 응답.
 * 판단(완료·보임)은 서버 `functions/src/lib/onboarding.ts`가 한다.
 */
export type AcademyOnboardingView = {
  steps: {
    classes: { done: boolean; count: number };
    students: { done: boolean; count: number };
    parents: { done: boolean; linkedCount: number; shared: boolean };
    staff: { done: boolean; count: number; noStaff: boolean };
  };
  doneCount: number;
  allDone: boolean;
  visible: boolean;
  settingOn: boolean;
};

export type AcademyOnboardingAction = "parent_link_shared" | "no_staff" | "undo_no_staff" | "hide" | "show";

function errText(e: unknown, fallback: string): string {
  return e instanceof FirebaseError && e.message ? e.message : fallback;
}

/** `enabled`(원장)일 때만 읽는다. 화면이 다시 보이면 다시 읽음 */
export function useAcademyOnboarding(academyId: string, enabled: boolean) {
  const [view, setView] = useState<AcademyOnboardingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const res = await httpsCallable<{ academyId: string }, AcademyOnboardingView>(
        getFirebaseFunctions(),
        "getAcademyOnboarding",
      )({ academyId });
      setView(res.data);
      setError(null);
    } catch (e) {
      setError(errText(e, "시작하기 안내를 불러오지 못했습니다."));
    }
  }, [academyId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled, load]);

  const act = useCallback(
    async (action: AcademyOnboardingAction): Promise<boolean> => {
      if (!enabled) return false;
      setBusy(true);
      try {
        const res = await httpsCallable<{ academyId: string; action: AcademyOnboardingAction }, AcademyOnboardingView>(
          getFirebaseFunctions(),
          "updateAcademyOnboarding",
        )({ academyId, action });
        setView(res.data);
        setError(null);
        return true;
      } catch (e) {
        setError(errText(e, "저장하지 못했습니다."));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [academyId, enabled],
  );

  return { view, error, busy, reload: load, act };
}

const recordedShare = new Set<string>();

/**
 * 학부모 가입 QR 카드의 공유류 버튼을 누름(M2-1 ③) — 원장 화면에서만 부른다. 한 화면 세션에 학원당 1번(서버도 처음 시각만 남김).
 * 실패해도 무시(공유 자체는 이미 됨).
 */
export function recordParentLinkShared(academyId: string): void {
  if (recordedShare.has(academyId)) return;
  recordedShare.add(academyId);
  void httpsCallable(getFirebaseFunctions(), "updateAcademyOnboarding")({ academyId, action: "parent_link_shared" }).catch(
    () => recordedShare.delete(academyId),
  );
}
