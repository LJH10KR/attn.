"use client";

import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ACADEMY_PERMISSION_GROUPS,
  ACADEMY_PERMISSIONS,
  normalizePermissionList,
  type AcademyNavTab,
  type AcademyPermission,
} from "@/lib/academy/permissions";
import { COLLECTIONS } from "@/lib/firebase/attn-schema";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";

/**
 * 학원 화면에서 현재 사용자가 무엇을 할 수 있는지 — 탭·페이지·버튼 노출 제어용.
 * 실제 차단은 보안 규칙과 서버 `assertPermission`이 하므로 여기서는 보여 줄지만 정한다.
 * - owner: 학원 문서 ownerUid — 모든 권한
 * - staff: 활성 직원 — 직원 문서 `permissions`(역할이 바뀌면 실시간 반영)
 */
export type AcademyActorKind = "owner" | "staff";

type PermissionSnapshot = {
  academyId: string;
  uid: string | null;
  actor: AcademyActorKind | null;
  permissions: readonly AcademyPermission[];
};

export type AcademyPermissionState = {
  loading: boolean;
  /** 학원과 무관한 계정이거나 비활성 직원이면 null */
  actor: AcademyActorKind | null;
  permissions: ReadonlySet<AcademyPermission>;
  /** 배열이면 그중 하나만 있어도 참 */
  can: (required: AcademyPermission | readonly AcademyPermission[]) => boolean;
  /** 권한이 하나라도 있는 하단 탭(홈 제외) */
  visibleTabs: AcademyNavTab[];
};

export function usePermissions(academyId: string | null): AcademyPermissionState {
  const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null);

  useEffect(() => {
    if (!academyId || !isFirebaseConfigured()) return;
    const auth = getFirebaseAuth();
    let cancelled = false;
    let unsubMember: (() => void) | null = null;

    const publish = (next: Omit<PermissionSnapshot, "academyId">) => {
      if (!cancelled) setSnapshot({ academyId, ...next });
    };

    const unsubAuth = onAuthStateChanged(auth, (user) => {
      unsubMember?.();
      unsubMember = null;
      if (!user) {
        publish({ uid: null, actor: null, permissions: [] });
        return;
      }
      void (async () => {
        try {
          const db = getFirebaseDb();
          const academySnap = await getDoc(doc(db, COLLECTIONS.academies, academyId));
          if (academySnap.get("ownerUid") === user.uid) {
            publish({ uid: user.uid, actor: "owner", permissions: ACADEMY_PERMISSIONS });
            return;
          }
          if (cancelled) return;
          unsubMember = onSnapshot(
            doc(db, COLLECTIONS.academies, academyId, "staff", user.uid),
            (snap) => {
              const active = snap.exists() && snap.get("status") === "active";
              publish({
                uid: user.uid,
                actor: active ? "staff" : null,
                permissions: active ? normalizePermissionList(snap.get("permissions")) : [],
              });
            },
            () => publish({ uid: user.uid, actor: null, permissions: [] }),
          );
        } catch {
          publish({ uid: user.uid, actor: null, permissions: [] });
        }
      })();
    });

    return () => {
      cancelled = true;
      unsubMember?.();
      unsubAuth();
    };
  }, [academyId]);

  const current = snapshot && snapshot.academyId === academyId ? snapshot : null;
  const permissionList = current?.permissions;
  const permissions = useMemo(
    () => new Set<AcademyPermission>(permissionList ?? []),
    [permissionList],
  );

  const can = useCallback(
    (required: AcademyPermission | readonly AcademyPermission[]) => {
      const list: readonly AcademyPermission[] =
        typeof required === "string" ? [required] : required;
      return list.some((p) => permissions.has(p));
    },
    [permissions],
  );

  const visibleTabs = useMemo(
    () =>
      ACADEMY_PERMISSION_GROUPS.filter((g) => g.permissions.some((p) => permissions.has(p.key))).map(
        (g) => g.tab,
      ),
    [permissions],
  );

  return {
    loading: Boolean(academyId) && isFirebaseConfigured() && current === null,
    actor: current?.actor ?? null,
    permissions,
    can,
    visibleTabs,
  };
}
