"use client";

import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useState } from "react";
import {
  normalizePermissionList,
  type AcademyPermission,
  type RoleTemplateKey,
} from "@/lib/academy/permissions";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";

export type AcademyRoleVM = {
  id: string;
  name: string;
  permissions: AcademyPermission[];
  /** 기본 템플릿 역할이면 키 — 삭제 불가 */
  template: RoleTemplateKey | null;
  memberCount: number;
};

/**
 * 학원 역할 목록(`listAcademyRoles` — 서버가 템플릿 역할을 보장하고 역할별 직원 수를 셈).
 * `enabled`가 거짓이면(멤버 초대/권한 관리 권한 없음) 부르지 않고 null.
 */
export function useAcademyRoles(
  academyId: string,
  enabled: boolean,
): { roles: AcademyRoleVM[] | null; error: string | null; refresh: () => void } {
  const [roles, setRoles] = useState<AcademyRoleVM[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled || !academyId) {
      setRoles(null);
      return;
    }
    let cancelled = false;
    void httpsCallable(getFirebaseFunctions(), "listAcademyRoles")({ academyId })
      .then((res) => {
        if (cancelled) return;
        const list = (res.data as { roles?: AcademyRoleVM[] }).roles ?? [];
        setRoles(
          list.map((r) => ({
            id: r.id,
            name: r.name,
            permissions: normalizePermissionList(r.permissions),
            template: r.template ?? null,
            memberCount: r.memberCount ?? 0,
          })),
        );
        setError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setRoles(null);
        setError("권한 목록을 불러오지 못했습니다.");
      });
    return () => {
      cancelled = true;
    };
  }, [academyId, enabled, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { roles, error, refresh };
}
