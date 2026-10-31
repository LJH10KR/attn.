"use client";

import { collection, doc, getDoc, getDocs } from "firebase/firestore";
import { useCallback, useEffect, useMemo, useState } from "react";
import { docToStaffRow } from "@/lib/academy/staff-row";
import { academyStaffPath, COLLECTIONS } from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";

/**
 * 반 선생님 후보(D6) — 원장 + `staff` 중 계정이 있는 직원(문서 ID = `authUid`, `no_account` 아님).
 * 원장 이름은 `users/{uid}`에 있어 직원이 읽을 수 없으므로 "원장"으로 표시한다.
 * 계정 비활성·퇴사 직원은 규칙상 반을 볼 수 없어 **새로 고를 수 없게**(`blocked`) 표시만 한다(서버는 막지 않음).
 * 읽기는 staff 규칙상 직원·멤버·원생·반 관리 권한 — 반 관리 화면에서만 쓴다.
 */
export type ClassTeacherCandidate = {
  uid: string;
  label: string;
  isOwner: boolean;
  /** 상태 배지(첫 로그인 전·승인 대기·휴직·게스트·계정 비활성·퇴사) */
  badge: string | null;
  /** 계정 비활성·퇴사 — 지정돼 있어도 반을 볼 수 없고, 새로 고를 수 없음 */
  blocked: boolean;
};

export function useClassTeacherCandidates(academyId: string, viewerUid: string | null) {
  const [state, setState] = useState<{
    loading: boolean;
    error: string | null;
    candidates: ClassTeacherCandidate[];
  }>({ loading: true, error: null, candidates: [] });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    void (async () => {
      try {
        const db = getFirebaseDb();
        const [academySnap, staffSnap] = await Promise.all([
          getDoc(doc(db, COLLECTIONS.academies, academyId)),
          getDocs(collection(db, academyStaffPath(academyId))),
        ]);
        const ownerUid = academySnap.get("ownerUid");
        const list: ClassTeacherCandidate[] = [];
        if (typeof ownerUid === "string" && ownerUid) {
          list.push({
            uid: ownerUid,
            label: ownerUid === viewerUid ? "원장 (나)" : "원장",
            isOwner: true,
            badge: null,
            blocked: false,
          });
        }
        const staff: ClassTeacherCandidate[] = [];
        for (const d of staffSnap.docs) {
          const data = d.data() as Record<string, unknown>;
          if (data.authUid !== d.id || data.status === "no_account" || d.id === ownerUid) continue;
          const row = docToStaffRow(d.id, data);
          const blocked = row.accountStatus === "inactive" || row.employmentStatus === "resigned";
          const badge =
            row.employmentStatus === "resigned"
              ? "퇴사"
              : row.accountStatus === "inactive"
                ? "계정 비활성"
                : row.accountStatus === "pending_setup"
                  ? "첫 로그인 전"
                  : row.accountStatus === "pending_registration"
                    ? "승인 대기"
                    : row.employmentStatus === "on_leave"
                      ? "휴직"
                      : row.isGuest
                        ? "게스트"
                        : null;
          const name = row.displayName || "이름 없음";
          staff.push({ uid: d.id, label: d.id === viewerUid ? `${name} (나)` : name, isOwner: false, badge, blocked });
        }
        staff.sort((a, b) => Number(a.blocked) - Number(b.blocked) || a.label.localeCompare(b.label, "ko"));
        if (!cancelled) setState({ loading: false, error: null, candidates: [...list, ...staff] });
      } catch {
        if (!cancelled) {
          setState({ loading: false, error: "선생님 목록을 불러오지 못했습니다.", candidates: [] });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyId, viewerUid, reloadKey]);

  const byUid = useMemo(
    () => new Map(state.candidates.map((c) => [c.uid, c])),
    [state.candidates],
  );
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  /** 목록·요약용 이름 — 반을 볼 수 없는 직원은 "(비활성)", 모르는 uid는 "알 수 없는 계정" */
  const teacherName = useCallback(
    (uid: string) => {
      const c = byUid.get(uid);
      if (!c) return state.loading ? "…" : "알 수 없는 계정";
      return c.blocked ? `${c.label} (${c.badge ?? "비활성"})` : c.label;
    },
    [byUid, state.loading],
  );

  /** 후보 목록 순서(원장 → 직원 이름순 → 비활성·퇴사 → 모르는 계정) */
  const sortUids = useCallback(
    (uids: readonly string[]) => {
      const order = new Map(state.candidates.map((c, i) => [c.uid, i]));
      return [...uids].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
    },
    [state.candidates],
  );

  return { ...state, byUid, teacherName, sortUids, reload };
}

/** "원장, 김선생 외 2명" — 없으면 "선생님 미지정" */
export function teacherSummary(uids: readonly string[], nameOf: (uid: string) => string, shown = 2): string {
  if (uids.length === 0) return "선생님 미지정";
  const names = uids.slice(0, shown).map(nameOf);
  const rest = uids.length - names.length;
  return rest > 0 ? `${names.join(", ")} 외 ${rest}명` : names.join(", ");
}
