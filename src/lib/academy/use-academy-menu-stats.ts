"use client";

import {
  collection,
  getCountFromServer,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { useEffect, useState } from "react";
import { academyMenu } from "@/lib/academy/academy-routes";
import type { AcademyNavTab, AcademyPermission } from "@/lib/academy/permissions";
import { kstMonthBounds, nowKST } from "@/lib/academy/kst-month";
import { docToStaffRow } from "@/lib/academy/staff-row";
import {
  STUDENT_STATUSES,
  STUDENT_STATUS_LABELS,
  type StudentStatus,
} from "@/lib/academy/student-profile";
import { academyPaymentsPath, academyStaffPath, COLLECTIONS } from "@/lib/firebase/attn-schema";
import { getFirebaseDb } from "@/lib/firebase/client-app";

export type AcademyMenuStat = { summary?: string; detail?: string; badge?: number };
export type AcademyMenuStats = Partial<Record<AcademyPermission, AcademyMenuStat>>;

type Loader = (academyId: string) => Promise<AcademyMenuStats>;

/** 메뉴별 요약 숫자 — 권한이 있는 메뉴만 읽는다(규칙과 같은 권한) */
const LOADERS: Partial<Record<AcademyPermission, Loader>> = {
  // 요약 = 자녀가 연결된 계정 수, 배지 = 가입 승인 대기(연결된 적 없는 계정 — 연결 해제로 돌아온 계정은 제외)
  "operations.parents": async (academyId) => {
    const parents = collection(getFirebaseDb(), COLLECTIONS.academies, academyId, "parents");
    const [linked, pending] = await Promise.all([
      getCountFromServer(query(parents, where("status", "==", "active"))),
      getCountFromServer(
        query(parents, where("status", "==", "pending_approval"), where("approvedAt", "==", null)),
      ),
    ]);
    return {
      "operations.parents": { summary: `연결 ${linked.data().count}명`, badge: pending.data().count },
    };
  },
  // 숫자는 재원 기준, 휴원·미등록·퇴원은 보조 줄에 따로(0이면 생략)
  "operations.students": async (academyId) => {
    const students = collection(getFirebaseDb(), COLLECTIONS.academies, academyId, "students");
    const counts = await Promise.all(
      STUDENT_STATUSES.map(async (status) => {
        const snap = await getCountFromServer(query(students, where("status", "==", status)));
        return [status, snap.data().count] as const;
      }),
    );
    const byStatus = Object.fromEntries(counts) as Record<StudentStatus, number>;
    const detail = STUDENT_STATUSES.filter((s) => s !== "enrolled" && byStatus[s] > 0)
      .map((s) => `${STUDENT_STATUS_LABELS[s]} ${byStatus[s]}`)
      .join(" · ");
    return {
      "operations.students": { summary: `재원 ${byStatus.enrolled}명`, ...(detail ? { detail } : {}) },
    };
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
  can: (required: AcademyPermission | readonly AcademyPermission[]) => boolean,
): { stats: AcademyMenuStats } {
  const [state, setState] = useState<{ key: string; stats: AcademyMenuStats } | null>(null);

  // 메뉴를 볼 수 있는 권한(access)과 같은 기준 — 결제 취소 권한만 있어도 결제 내역 건수를 읽는다
  const permitted = (Object.keys(LOADERS) as AcademyPermission[]).filter(
    (p) => p.startsWith(`${tab}.`) && can(academyMenu(p)?.access ?? p),
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
