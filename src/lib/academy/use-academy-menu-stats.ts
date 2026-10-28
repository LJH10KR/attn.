"use client";

import {
  collection,
  getCountFromServer,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { useEffect, useState } from "react";
import type { AcademyNavTab, AcademyPermission } from "@/lib/academy/permissions";
import { kstMonthBounds, nowKST } from "@/lib/academy/kst-month";
import { docToStaffRow } from "@/lib/academy/staff-row";
import { academyPaymentsPath, academyStaffPath, COLLECTIONS } from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";

export type AcademyMenuStat = { summary?: string; badge?: number };
export type AcademyMenuStats = Partial<Record<AcademyPermission, AcademyMenuStat>>;

type Loader = (academyId: string) => Promise<AcademyMenuStats>;

/** 메뉴별 요약 숫자 — 권한이 있는 메뉴만 읽는다(규칙과 같은 권한) */
const LOADERS: Partial<Record<AcademyPermission, Loader>> = {
  "operations.parents": async (academyId) => {
    const parents = collection(getFirebaseDb(), COLLECTIONS.academies, academyId, "parents");
    const [all, pending] = await Promise.all([
      getCountFromServer(parents),
      getCountFromServer(query(parents, where("status", "==", "pending_registration"))),
    ]);
    return {
      "operations.parents": { summary: `${all.data().count}명`, badge: pending.data().count },
    };
  },
  "operations.students": async (academyId) => {
    const snap = await getCountFromServer(
      collection(getFirebaseDb(), COLLECTIONS.academies, academyId, "students"),
    );
    return { "operations.students": { summary: `${snap.data().count}명` } };
  },
  "billing.payments": async (academyId) => {
    const { year, month } = nowKST();
    const { start, end } = kstMonthBounds(year, month);
    const snap = await getCountFromServer(
      query(
        collection(getFirebaseDb(), academyPaymentsPath(academyId)),
        where("createdAt", ">=", start),
        where("createdAt", "<", end),
      ),
    );
    return { "billing.payments": { summary: `이번 달 ${snap.data().count}건` } };
  },
};

/** 직원·멤버는 목록이 작아 한 번 읽어 함께 센다 */
async function loadStaffStats(
  academyId: string,
  staffMenu: boolean,
  membersMenu: boolean,
): Promise<AcademyMenuStats> {
  const snap = await getDocs(collection(getFirebaseDb(), academyStaffPath(academyId)));
  const rows = snap.docs.map((d) => docToStaffRow(d.id, d.data() as Record<string, unknown>));
  const out: AcademyMenuStats = {};
  if (staffMenu) {
    const current = rows.filter((r) => !r.isGuest && r.employmentStatus !== "resigned").length;
    out["settings.staff"] = { summary: `${current}명` };
  }
  if (membersMenu) {
    const members = rows.filter((r) => r.accountStatus !== "no_account");
    out["settings.members"] = {
      summary: `${members.length}명`,
      badge: members.filter((r) => r.accountStatus === "pending_registration").length,
    };
  }
  return out;
}

/** 탭 요약 화면의 메뉴 배지·보조 문구 — 실패한 메뉴는 비워 둔다 */
export function useAcademyMenuStats(
  academyId: string,
  tab: AcademyNavTab,
  can: (p: AcademyPermission) => boolean,
): { stats: AcademyMenuStats } {
  const [state, setState] = useState<{ key: string; stats: AcademyMenuStats } | null>(null);

  const permitted = (Object.keys(LOADERS) as AcademyPermission[]).filter(
    (p) => p.startsWith(`${tab}.`) && can(p),
  );
  const staffMenu = tab === "settings" && can("settings.staff");
  const membersMenu = tab === "settings" && can("settings.members");
  const key = `${academyId}|${permitted.join(",")}|${staffMenu}|${membersMenu}`;

  useEffect(() => {
    let cancelled = false;
    const tasks: Promise<AcademyMenuStats>[] = permitted.map((p) =>
      LOADERS[p]!(academyId).catch(() => ({})),
    );
    if (staffMenu || membersMenu) {
      tasks.push(loadStaffStats(academyId, staffMenu, membersMenu).catch(() => ({})));
    }
    void Promise.all(tasks).then((parts) => {
      if (!cancelled) setState({ key, stats: Object.assign({}, ...parts) as AcademyMenuStats });
    });
    return () => {
      cancelled = true;
    };
    // key가 academyId·권한 목록을 모두 담는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { stats: state?.key === key ? state.stats : {} };
}
