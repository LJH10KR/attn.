"use client";

import { collection, getDocs, limit, orderBy, query, Timestamp } from "firebase/firestore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardNotificationRow } from "@/components/dashboard/dashboard-notifications-modal";
import {
  ACADEMY_ADMIN_INBOX_SCHEMA_VERSION,
  academyAdminInboxCollectionPath,
  TEACHER_INVITE_TTL_MS,
  type AcademyAdminInboxDoc,
} from "@/lib/firebase/attn-schema";
import { memberWithdrawnBellText } from "@/lib/auth/account-withdrawal-text";
import { getFirebaseDb } from "@/lib/firebase/client-app";
import { useDashboardRefetchOnFocus } from "@/lib/firebase/use-dashboard-refetch-on-focus";
import { setAppIconBadgeCount } from "@/lib/ios/app-badge";

function readTs(v: unknown): Timestamp | undefined {
  return v instanceof Timestamp ? v : undefined;
}

function inviteExpired(
  invitedAt: Timestamp | undefined,
  invitationExpiresAt: Timestamp | undefined,
  ttlMs: number,
  now: number,
): boolean {
  let exp = invitationExpiresAt;
  if (!exp && invitedAt) {
    exp = Timestamp.fromMillis(invitedAt.toMillis() + ttlMs);
  }
  if (!exp) return false;
  return exp.toMillis() <= now;
}

type BellLinks = {
  /** 학부모 승인 대기 바로 가기(학부모 관리 `?view=pending`) — `operations.parents` 권한이 있을 때만 */
  parentsPendingHref?: string | null;
  /**
   * 가입 링크 한도 알림(2-K) 바로 가기 — 학부모 링크는 학부모 관리(`operations.parents`), 직원 링크는 멤버 초대/권한 관리
   * (`settings.members`). null이면 그 권한이 없으므로 알림 자체를 보여 주지 않는다(벨 읽기 규칙은 더 넓음).
   */
  signupLinkHrefs?: { parent: string | null; staff: string | null };
  /**
   * 2-L 정보성 알림 바로 가기 — 학부모 알림(자동 연결·내 자녀 아님·번호 변경)은 학부모 관리(`operations.parents`),
   * 직원 자동 활성은 멤버 관리(`settings.members`). null이면 그 권한이 없어 알림을 보여 주지 않는다.
   */
  parentsHref?: string | null;
  membersHref?: string | null;
};

function mapInboxDoc(
  id: string,
  data: Record<string, unknown>,
  now: number,
  links: BellLinks,
): DashboardNotificationRow[] {
  if (data.schemaVersion !== ACADEMY_ADMIN_INBOX_SCHEMA_VERSION) return [];

  const kind = data.kind as AcademyAdminInboxDoc["kind"];
  const entityType = data.entityType as AcademyAdminInboxDoc["entityType"];
  const name =
    typeof data.displayName === "string" && data.displayName.trim()
      ? data.displayName.trim()
      : "이름 미입력";
  const email = typeof data.email === "string" ? data.email : "";
  const invitedAt = readTs(data.invitedAt);
  const invitationExpiresAt = readTs(data.invitationExpiresAt);
  const roleLabel = entityType === "teacher" ? "선생님" : "학부모";

  if (kind === "parent_pending_approval") {
    return [
      {
        id,
        title: `학부모 가입 승인 대기: ${name}`,
        detail: "학부모 관리에서 자녀를 연결해 주세요.",
        ...(links.parentsPendingHref ? { href: links.parentsPendingHref, hrefLabel: "승인하러 가기" } : {}),
      },
    ];
  }

  // 아래 두 종류는 직원 계정(학부모 이메일 초청은 2-C에서 폐지 — 남은 학부모 항목은 표시하지 않음)
  if (entityType !== "teacher" && (kind === "pending_registration" || kind === "invitation_sent")) {
    return [];
  }

  if (kind === "pending_registration") {
    return [
      {
        id,
        title: `${roleLabel} 최종 등록 대기: ${name}`,
        detail: email || undefined,
      },
    ];
  }

  if (kind === "invitation_sent") {
    if (inviteExpired(invitedAt, invitationExpiresAt, TEACHER_INVITE_TTL_MS, now)) {
      return [
        {
          id,
          title: `${roleLabel} 초청 만료: ${name}`,
          detail: email ? `${email} · 초청 재발송이 필요합니다` : "초청 재발송이 필요합니다",
        },
      ];
    }
  }

  if (kind === "signup_rate_limited") {
    const linkKind = data.linkKind === "staff" ? "staff" : data.linkKind === "parent" ? "parent" : null;
    const href = linkKind ? links.signupLinkHrefs?.[linkKind] ?? null : null;
    if (!linkKind || !href) return [];
    return [
      {
        id,
        title: `「${linkKind === "parent" ? "학부모" : "직원"} 가입 링크」 가입 요청이 많아 잠시 멈췄습니다`,
        detail: "링크가 퍼졌다면 다시 만들어 주세요.",
        href,
        hrefLabel: "가입 링크 관리",
      },
    ];
  }

  if (kind === "parent_auto_linked" || kind === "parent_child_declined" || kind === "parent_phone_changed") {
    if (!links.parentsHref) return [];
    const exp = readTs(data.expiresAt);
    if (exp && exp.toMillis() <= now) return [];
    const studentName = typeof data.studentName === "string" && data.studentName.trim() ? data.studentName.trim() : "학생";
    const common = { id, href: links.parentsHref, hrefLabel: "학부모 관리" };
    if (kind === "parent_auto_linked") {
      return [{
        ...common,
        title: `번호 확인으로 자동 연결: ${name} 학부모 ↔ ${studentName}`,
        detail: "학부모가 문자로 번호를 확인해 학원에 등록된 보호자 번호와 연결됐습니다. 잘못 연결됐다면 학부모 관리에서 해제해 주세요.",
      }];
    }
    if (kind === "parent_child_declined") {
      return [{
        ...common,
        title: `${name} 학부모가 ${studentName} 연결을 해제했습니다`,
        detail: "학부모가 「내 자녀가 아니에요」를 눌렀습니다. 원생의 보호자 번호를 확인해 주세요.",
      }];
    }
    const variant = data.variant;
    return [{
      ...common,
      title:
        variant === "corrected"
          ? `${name} 학부모가 확인한 번호로 바로잡았습니다`
          : variant === "reverted"
            ? `${name} 학부모가 번호를 바꾸지 않았다고 알려 왔습니다`
            : `${name} 학부모가 번호를 바꿨습니다(문자 확인됨)`,
      detail:
        variant === "corrected"
          ? "학원이 적은 번호 대신 학부모가 문자로 확인한 번호를 계정과 연결된 보호자 칸에 기록했습니다."
          : variant === "reverted"
            ? "연결된 보호자 칸 번호를 계정 번호(문자 확인됨)로 되돌렸습니다."
            : "연결된 원생의 보호자 번호도 함께 바뀌었습니다.",
    }];
  }

  if (kind === "staff_auto_activated") {
    if (!links.membersHref) return [];
    const exp = readTs(data.expiresAt);
    if (exp && exp.toMillis() <= now) return [];
    const roleName = typeof data.roleName === "string" && data.roleName.trim() ? data.roleName.trim() : "미리 정한 권한";
    return [{
      id,
      title: `${name} 님이 번호 확인으로 바로 가입했습니다`,
      detail: `미리 등록한 직원 정보와 「${roleName}」 권한으로 사용 중입니다.`,
      href: links.membersHref,
      hrefLabel: "멤버 관리",
    }];
  }

  // 2-M 아이디·비밀번호 찾기 — 문자 확인으로 비밀번호 재설정(학부모는 학부모 관리, 직원은 멤버 관리 권한일 때만)
  if (kind === "member_password_reset") {
    const isParent = entityType !== "teacher";
    const href = isParent ? links.parentsHref : links.membersHref;
    if (!href) return [];
    const exp = readTs(data.expiresAt);
    if (exp && exp.toMillis() <= now) return [];
    return [{
      id,
      title: `${name} ${isParent ? "학부모" : "직원"}이 문자 확인으로 비밀번호를 바꿨습니다`,
      detail: "다른 기기의 로그인은 모두 끊겼습니다. 본인이 한 일이 아니라면 계정을 비활성화하고 확인해 주세요.",
      href,
      hrefLabel: isParent ? "학부모 관리" : "멤버 관리",
    }];
  }

  // 2-N 본인 회원 탈퇴 — 학부모는 학부모 관리, 직원은 멤버 관리 권한일 때만(30일 만료)
  if (kind === "member_withdrawn") {
    const isParent = entityType !== "teacher";
    const href = isParent ? links.parentsHref : links.membersHref;
    if (!href) return [];
    const exp = readTs(data.expiresAt);
    if (exp && exp.toMillis() <= now) return [];
    return [{
      id,
      ...memberWithdrawnBellText(name, isParent ? "parent" : "teacher", data.variant),
      href,
      hrefLabel: isParent ? "학부모 관리" : "멤버 관리",
    }];
  }

  if (kind === "session_payment_received") {
    const studentName =
      typeof data.studentName === "string" && data.studentName.trim()
        ? data.studentName.trim()
        : name;
    const sessionCount =
      typeof data.sessionCount === "number" &&
      Number.isInteger(data.sessionCount) &&
      data.sessionCount > 0
        ? data.sessionCount
        : null;
    return [
      {
        id,
        title:
          sessionCount != null
            ? `${studentName} 학생 ${sessionCount}회 자동 충전 완료`
            : `${studentName} 학생 회차 자동 충전 완료`,
        detail: "결제 및 회차 충전이 완료됐습니다. 결제 내역에서 확인하실 수 있습니다.",
      },
    ];
  }

  return [];
}

function dismissedStorageKey(academyId: string): string {
  return `attn_academy_bell_dismissed_v1_${academyId}`;
}

function loadDismissed(academyId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(dismissedStorageKey(academyId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function saveDismissed(academyId: string, set: Set<string>): void {
  try {
    const arr = [...set].slice(0, 400);
    localStorage.setItem(dismissedStorageKey(academyId), JSON.stringify(arr));
  } catch {
    /* quota / private mode */
  }
}

/** 초청 만료 판정용 클라이언트 시계 — 직원 inbox `invitation_sent` 항목 표시용 */
const BELL_EXPIRY_TICK_MS = 60_000;

/**
 * 학원 대시보드 알림벨 — `adminInbox` (Functions 유지) 기반.
 * Firestore는 마운트·탭 복귀·`refresh()`(모달 열기 등) 시에만 조회합니다.
 */
export function useAcademyDashboardBell(academyId: string | null, links: BellLinks = {}) {
  const parentsPendingHref = links.parentsPendingHref ?? null;
  const signupParentHref = links.signupLinkHrefs?.parent ?? null;
  const signupStaffHref = links.signupLinkHrefs?.staff ?? null;
  const parentsHref = links.parentsHref ?? null;
  const membersHref = links.membersHref ?? null;
  const [inboxDocs, setInboxDocs] = useState<{ id: string; data: Record<string, unknown> }[]>(
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  const rawItemsRef = useRef<DashboardNotificationRow[]>([]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), BELL_EXPIRY_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!academyId) {
      setDismissed(new Set());
      return;
    }
    setDismissed(loadDismissed(academyId));
  }, [academyId]);

  const loadBellInbox = useCallback(async () => {
    if (!academyId) {
      setInboxDocs([]);
      setError(null);
      return;
    }
    try {
      const db = getFirebaseDb();
      const snap = await getDocs(
        query(
          collection(db, academyAdminInboxCollectionPath(academyId)),
          orderBy("createdAt", "desc"),
          limit(50),
        ),
      );
      setError(null);
      setInboxDocs(
        snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "알림을 불러오지 못했습니다.";
      setError(msg);
      setInboxDocs([]);
    }
  }, [academyId]);

  const { refresh } = useDashboardRefetchOnFocus(loadBellInbox, [academyId], {
    pollMs: 0,
    loadOnMount: Boolean(academyId),
  });

  const rawItems = useMemo(() => {
    const now = nowMs;
    const out: DashboardNotificationRow[] = [];
    for (const d of inboxDocs) {
      out.push(
        ...mapInboxDoc(d.id, d.data, now, {
          parentsPendingHref,
          signupLinkHrefs: { parent: signupParentHref, staff: signupStaffHref },
          parentsHref,
          membersHref,
        }),
      );
    }
    out.sort((a, b) => a.title.localeCompare(b.title, "ko"));
    return out;
  }, [inboxDocs, nowMs, parentsPendingHref, signupParentHref, signupStaffHref, parentsHref, membersHref]);

  rawItemsRef.current = rawItems;

  const rawIdsKey = useMemo(
    () =>
      rawItems
        .map((i) => i.id)
        .sort()
        .join("\u0001"),
    [rawItems],
  );

  useEffect(() => {
    if (!academyId) return;
    const raw = rawItemsRef.current;
    const rawIds = new Set(raw.map((i) => i.id));
    if (rawIds.size === 0) return;
    setDismissed((prev) => {
      const next = new Set([...prev].filter((id) => rawIds.has(id)));
      if (next.size === prev.size && [...prev].every((id) => next.has(id))) return prev;
      saveDismissed(academyId, next);
      return next;
    });
  }, [academyId, rawIdsKey]);

  const items = useMemo(
    () => rawItems.filter((i) => !dismissed.has(i.id)),
    [rawItems, dismissed],
  );

  useEffect(() => {
    setAppIconBadgeCount(items.length, {
      badgeUserId: academyId ? `academy:${academyId}` : undefined,
    });
  }, [items.length, academyId]);

  const dismissOne = useCallback(
    (id: string) => {
      if (!academyId) return;
      setDismissed((prev) => {
        const next = new Set(prev);
        next.add(id);
        saveDismissed(academyId, next);
        return next;
      });
    },
    [academyId],
  );

  const dismissAllVisible = useCallback(() => {
    if (!academyId) return;
    setDismissed((prev) => {
      const next = new Set(prev);
      rawItemsRef.current.forEach((i) => next.add(i.id));
      saveDismissed(academyId, next);
      return next;
    });
  }, [academyId]);

  return {
    items,
    error,
    count: items.length,
    dismissOne,
    dismissAllVisible,
    refresh,
  };
}
