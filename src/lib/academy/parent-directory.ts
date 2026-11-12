import { digitsOnly } from "@/lib/phone/kr-phone";
import type { ParentAccountStatus, StudentGuardian } from "@/lib/firebase/attn-schema";
import type { StudentVM } from "@/lib/academy/student-row";

/**
 * 학부모 관리(9-5) 화면용 순수 함수 — 원생 보호자(guardians)와 학부모 앱 계정(parents)을 번호로 묶는다.
 * 묶기·앱 상태·푸시 상태·계정 상태별 동작 판단을 모두 여기 둔다(화면은 결과만 그린다).
 */

// ---------------------------------------------------------------- 계정

export type ParentAccountVM = {
  uid: string;
  displayName: string;
  loginId: string;
  /** 저장된 번호 그대로(없으면 "") */
  phone: string;
  /** 번호 숫자만 — 서버 `guardianPhoneKey`와 같음(없으면 "") */
  phoneKey: string;
  /** 2-L — 계정 번호가 휴대폰 문자로 확인된 번호(`phoneVerifiedKey` = 지금 번호) */
  phoneVerified: boolean;
  status: ParentAccountStatus;
  /** 첫 연결(승인) 기록이 있음 — `pending_approval`이면서 참이면 "연결 해제됨" */
  approved: boolean;
  authProvider: "password" | "google";
  linkedStudentIds: string[];
  pushEnabled: boolean | null;
  pushTokenCount: number | null;
  pushSyncedAtMs: number | null;
  createdAtMs: number;
};

const PARENT_STATUSES: readonly ParentAccountStatus[] = [
  "pending_email_verification",
  "pending_setup",
  "pending_approval",
  "active",
  "inactive",
];

function millis(raw: unknown): number {
  return raw && typeof raw === "object" && "toMillis" in raw && typeof raw.toMillis === "function"
    ? (raw.toMillis as () => number)()
    : 0;
}

/** 번호 묶음 키 — 숫자만(서버 `guardianPhoneKey`) */
export function phoneKey(phone: string | null | undefined): string {
  return digitsOnly(phone ?? "");
}

export function docToParentAccount(id: string, data: Record<string, unknown>): ParentAccountVM {
  const phone = typeof data.phone === "string" ? data.phone.trim() : "";
  const status = PARENT_STATUSES.includes(data.status as ParentAccountStatus)
    ? (data.status as ParentAccountStatus)
    : "pending_setup";
  const attnId = typeof data.attnId === "string" ? data.attnId : "";
  const syncedMs = millis(data.pushSyncedAt);
  return {
    uid: id,
    displayName: typeof data.displayName === "string" ? data.displayName.trim() : "",
    loginId: typeof data.loginId === "string" && data.loginId ? data.loginId : attnId,
    phone,
    phoneKey: phoneKey(phone),
    phoneVerified: phoneKey(phone).length > 0 && data.phoneVerifiedKey === phoneKey(phone),
    status,
    approved: data.approvedAt != null,
    authProvider: data.authProvider === "google" ? "google" : "password",
    linkedStudentIds: Array.isArray(data.linkedStudentIds)
      ? data.linkedStudentIds.filter((x): x is string => typeof x === "string")
      : [],
    pushEnabled: typeof data.pushEnabled === "boolean" ? data.pushEnabled : null,
    pushTokenCount: typeof data.pushTokenCount === "number" ? data.pushTokenCount : null,
    pushSyncedAtMs: syncedMs > 0 ? syncedMs : null,
    createdAtMs: millis(data.createdAt),
  };
}

// ---------------------------------------------------------------- 앱 상태

/** 앱 상태 — 미가입은 계정이 없는 묶음(계정 단위가 아님) */
export type ParentAppState =
  | "email_unverified"
  | "setup"
  | "pending"
  | "unlinked"
  | "linked"
  | "inactive";

export function parentAppState(a: Pick<ParentAccountVM, "status" | "approved">): ParentAppState {
  switch (a.status) {
    case "pending_email_verification":
      return "email_unverified";
    case "pending_setup":
      return "setup";
    case "pending_approval":
      return a.approved ? "unlinked" : "pending";
    case "active":
      return "linked";
    default:
      return "inactive";
  }
}

export const PARENT_APP_STATE_LABELS: Record<ParentAppState | "none", string> = {
  none: "미가입",
  email_unverified: "이메일 인증 전",
  setup: "첫 로그인 전",
  pending: "승인 대기",
  unlinked: "연결 해제됨",
  linked: "연결됨",
  inactive: "비활성",
};

export const PARENT_APP_STATE_BADGE_CLASS: Record<ParentAppState | "none", string> = {
  none: "bg-neutral-500/12 text-neutral-600",
  email_unverified: "bg-neutral-500/15 text-neutral-700",
  setup: "bg-sky-500/15 text-sky-900",
  pending: "bg-amber-500/20 text-amber-950",
  unlinked: "bg-orange-500/15 text-orange-900",
  linked: "bg-emerald-500/15 text-emerald-900",
  inactive: "bg-red-500/12 text-red-800",
};

/** 가입 승인 대기(배지·벨과 같은 기준) — `pending_approval && approvedAt == null` */
export function isAwaitingApproval(a: Pick<ParentAccountVM, "status" | "approved">): boolean {
  return a.status === "pending_approval" && !a.approved;
}

/** 대표 계정 순서: 연결됨 → 첫 로그인 전 → 연결 해제됨 → 승인 대기 → 그 밖 */
const REPRESENTATIVE_ORDER: Record<ParentAppState, number> = {
  linked: 0,
  setup: 1,
  unlinked: 2,
  pending: 3,
  email_unverified: 4,
  inactive: 5,
};

export function compareAccountsForCard(a: ParentAccountVM, b: ParentAccountVM): number {
  return (
    REPRESENTATIVE_ORDER[parentAppState(a)] - REPRESENTATIVE_ORDER[parentAppState(b)] ||
    a.createdAtMs - b.createdAtMs ||
    a.uid.localeCompare(b.uid)
  );
}

// ---------------------------------------------------------------- 푸시

export type ParentPushState = "on" | "off" | "check";

/** 동기화가 이보다 오래되면 "확인 필요" */
export const PUSH_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 푸시 상태 — 알림 수신자가 연결됨(active) 계정뿐이라(설계 4-5) **active일 때만** 판단, 그 밖은 null(표시 없음).
 * 동기화 기록 없음 → 확인 필요 / 꺼짐 / 토큰 0 또는 30일 넘게 동기화 없음 → 확인 필요 / 그 밖 → 켜짐.
 */
export function parentPushState(a: ParentAccountVM, nowMs: number): ParentPushState | null {
  if (a.status !== "active") return null;
  if (a.pushSyncedAtMs == null) return "check";
  if (a.pushEnabled === false) return "off";
  if (!a.pushTokenCount || nowMs - a.pushSyncedAtMs > PUSH_STALE_MS) return "check";
  return "on";
}

export const PARENT_PUSH_LABELS: Record<ParentPushState, string> = {
  on: "알림 켜짐",
  off: "알림 꺼짐",
  check: "알림 확인 필요",
};

// ---------------------------------------------------------------- 계정 상태별 동작(서버 허용 상태와 같게)

export type ParentAccountActions = {
  /** 원생 연결(승인·다시 연결·더 연결) — `linkParentToStudents`: 첫 로그인 전·승인 대기·연결됨 + 계정 번호 있음 */
  link: boolean;
  /** 상태로는 연결할 수 있지만 계정 번호가 비어 있음 — 버튼 대신 안내 */
  linkNeedsPhone: boolean;
  /** 자녀별 연결 해제 — 서버는 상태 검사 없음(연결된 자녀가 있을 때만 버튼) */
  unlink: boolean;
  /** `deactivateParent`: 연결됨·승인 대기(연결 해제됨 포함) */
  deactivate: boolean;
  /** `activateParent`: 비활성만 */
  activate: boolean;
  /** `resetMemberPassword`: 연결됨·승인 대기 + 로그인 비밀번호 있음(Google 전용 계정 제외) */
  resetPassword: boolean;
  /** `regenerateMemberTempPassword`: 첫 로그인 전만 */
  regenerate: boolean;
  /** `deleteParentAccount`: 모든 상태 */
  delete: true;
  /** 이메일 인증 전·승인 대기 계정 삭제는 "가입 거절" */
  deleteLabel: "가입 거절" | "계정 삭제";
};

export function parentAccountActions(
  a: Pick<ParentAccountVM, "status" | "approved" | "authProvider" | "phone">,
): ParentAccountActions {
  const s = a.status;
  const linkable = s === "pending_setup" || s === "pending_approval" || s === "active";
  const hasPhone = a.phone.trim().length > 0;
  return {
    link: linkable && hasPhone,
    linkNeedsPhone: linkable && !hasPhone,
    unlink: s !== "pending_email_verification",
    deactivate: s === "active" || s === "pending_approval",
    activate: s === "inactive",
    resetPassword: (s === "active" || s === "pending_approval") && a.authProvider !== "google",
    regenerate: s === "pending_setup",
    delete: true,
    deleteLabel: s === "pending_email_verification" || isAwaitingApproval(a) ? "가입 거절" : "계정 삭제",
  };
}

/**
 * 같은 번호의 다른 계정이 연결을 막는지(2-G 확정 1) — 그 계정이 승인된 적 있거나(`approvedAt`) 연결됨(active)이면
 * 번호 색인을 잡고 있다고 보고 저장을 막는다. `approvedAt`은 연결 뒤 따로 기록되어 빠질 수 있어 active를 더한다.
 * 이 판단이 틀리는 드문 경우는 서버가 거부한다.
 */
export function blocksSamePhoneLink(other: Pick<ParentAccountVM, "status" | "approved">): boolean {
  return other.approved || other.status === "active";
}

// ---------------------------------------------------------------- 번호 묶음

export type GuardianEntry = {
  studentId: string;
  guardian: StudentGuardian;
};

export type GroupChild = {
  student: StudentVM;
  /** 이 묶음 번호의 보호자 항목(없으면 계정 연결로만 들어온 자녀) */
  entry: StudentGuardian | null;
  /** 이 카드의 계정 중 이 자녀에 연결된 계정 uid */
  linkedUids: string[];
  /** 이 묶음 항목이 다른 카드의 계정에 연결됨 — 그 계정 */
  foreignAccount: ParentAccountVM | null;
  /** 계정 번호와 다른 번호의 보호자 항목으로 연결됨 — 원생 쪽 번호 */
  mismatchPhone: string | null;
};

export type GuardianGroup = {
  /** 번호 키(숫자) 또는 맞는 원생이 없는 계정 묶음이면 `u:` + 번호 키·uid */
  key: string;
  /** 표시 번호 */
  phone: string;
  /** 원생 보호자 번호와 맞지 않는 계정만 있는 묶음 */
  unmatched: boolean;
  entries: GuardianEntry[];
  /** 이 카드에 붙은 계정 — 대표 순서 */
  accounts: ParentAccountVM[];
  children: GroupChild[];
  displayName: string;
  /** 계정 이름이 표시 이름과 다를 때 "앱: ○○" */
  appName: string | null;
  relationIds: string[];
  /** 이 묶음 항목 중 다른 카드의 계정에 연결된 것이 있음 — 미가입으로 세지 않고 직접 만들기도 막음 */
  hasForeignLinks: boolean;
};

export function groupAppState(g: GuardianGroup): ParentAppState | "none" {
  const rep = g.accounts[0];
  return rep ? parentAppState(rep) : "none";
}

/** 미가입 = 계정이 없고, 다른 번호의 계정에 연결된 항목도 없는 묶음 */
export function isGroupUnregistered(g: GuardianGroup): boolean {
  return g.accounts.length === 0 && !g.hasForeignLinks && !g.unmatched;
}

/** 직접 만들어 주기(2-G 보강 B3) — 계정이 하나도 없는 묶음에서만(다른 번호 계정에 연결된 항목이 있어도 제외) */
export function canCreateForGroup(g: GuardianGroup): boolean {
  return isGroupUnregistered(g) && g.phone.length > 0;
}

/**
 * 원생 보호자 + 계정을 번호로 묶는다(2-G 보강 B2 — **계정 1개는 카드 1장에만**).
 * 1. 계정 번호와 같은 묶음이 있으면 그 묶음 하나에만 붙인다.
 * 2. 없고 그 계정에 연결된 보호자 항목이 있으면 연결된 항목이 있는 묶음 중 (정렬 순서) 첫 번째에.
 * 3. 둘 다 아니면 "원생 보호자 번호와 맞지 않는 계정" 묶음(번호별).
 * 카드 자녀 = 그 번호가 보호자인 학생 ∪ 붙은 계정이 `parentUids`에 있는 학생.
 */
export function buildGuardianDirectory(
  students: readonly StudentVM[],
  accounts: readonly ParentAccountVM[],
): GuardianGroup[] {
  const studentById = new Map(students.map((s) => [s.id, s]));
  const accountByUid = new Map(accounts.map((a) => [a.uid, a]));

  // 1) 번호별 보호자 항목
  const entriesByKey = new Map<string, GuardianEntry[]>();
  for (const s of students) {
    for (const g of s.guardians) {
      const key = phoneKey(g.phone);
      if (!key) continue;
      const list = entriesByKey.get(key);
      if (list) list.push({ studentId: s.id, guardian: g });
      else entriesByKey.set(key, [{ studentId: s.id, guardian: g }]);
    }
  }

  const entryName = (list: GuardianEntry[]): string => {
    const primary = list.find((e) => e.guardian.isPrimary && e.guardian.name)?.guardian.name;
    return primary ?? list.find((e) => e.guardian.name)?.guardian.name ?? "";
  };
  // 정렬 기준(배치 규칙 2의 "첫 번째"도 이 순서): 보호자 이름 → 번호
  const keys = [...entriesByKey.keys()].sort((a, b) => {
    const na = entryName(entriesByKey.get(a)!);
    const nb = entryName(entriesByKey.get(b)!);
    if (na && !nb) return -1;
    if (!na && nb) return 1;
    return na.localeCompare(nb, "ko") || a.localeCompare(b);
  });
  const keyOrder = new Map(keys.map((k, i) => [k, i]));

  // 2) 계정 배치
  const placedKey = new Map<string, string>();
  const unmatchedByKey = new Map<string, ParentAccountVM[]>();
  for (const a of accounts) {
    if (a.phoneKey && entriesByKey.has(a.phoneKey)) {
      placedKey.set(a.uid, a.phoneKey);
      continue;
    }
    const linkedKeys = keys.filter((k) => entriesByKey.get(k)!.some((e) => e.guardian.linkedParentUid === a.uid));
    if (linkedKeys.length > 0) {
      placedKey.set(a.uid, linkedKeys.sort((x, y) => keyOrder.get(x)! - keyOrder.get(y)!)[0]!);
      continue;
    }
    const uKey = `u:${a.phoneKey || a.uid}`;
    placedKey.set(a.uid, uKey);
    const list = unmatchedByKey.get(uKey);
    if (list) list.push(a);
    else unmatchedByKey.set(uKey, [a]);
  }
  const accountsByKey = new Map<string, ParentAccountVM[]>();
  for (const a of accounts) {
    const k = placedKey.get(a.uid)!;
    const list = accountsByKey.get(k);
    if (list) list.push(a);
    else accountsByKey.set(k, [a]);
  }

  const makeGroup = (key: string, entries: GuardianEntry[], unmatched: boolean): GuardianGroup => {
    const cardAccounts = [...(accountsByKey.get(key) ?? [])].sort(compareAccountsForCard);
    const cardUids = new Set(cardAccounts.map((a) => a.uid));
    const childIds: string[] = [];
    const seen = new Set<string>();
    const addChild = (id: string) => {
      if (seen.has(id) || !studentById.has(id)) return;
      seen.add(id);
      childIds.push(id);
    };
    for (const e of entries) addChild(e.studentId);
    for (const s of students) if (s.parentUids.some((u) => cardUids.has(u))) addChild(s.id);

    let hasForeignLinks = false;
    const children: GroupChild[] = childIds.map((id) => {
      const student = studentById.get(id)!;
      const entry = entries.find((e) => e.studentId === id)?.guardian ?? null;
      const linkedUids = student.parentUids.filter((u) => cardUids.has(u));
      const foreignUid = entry?.linkedParentUid && !cardUids.has(entry.linkedParentUid) ? entry.linkedParentUid : null;
      const foreignAccount = foreignUid ? accountByUid.get(foreignUid) ?? null : null;
      if (foreignUid) hasForeignLinks = true;
      // 계정 번호와 다른 번호의 보호자 항목으로 연결된 경우 — 원생 쪽 번호
      let mismatchPhone: string | null = null;
      for (const uid of linkedUids) {
        const acc = accountByUid.get(uid);
        const linkedEntry = student.guardians.find((g) => g.linkedParentUid === uid);
        if (acc && linkedEntry && phoneKey(linkedEntry.phone) !== acc.phoneKey) {
          mismatchPhone = linkedEntry.phone;
          break;
        }
      }
      return { student, entry, linkedUids, foreignAccount, mismatchPhone };
    });
    children.sort((a, b) => a.student.name.localeCompare(b.student.name, "ko"));

    const rep = cardAccounts[0] ?? null;
    const linkedAccountName = entries
      .map((e) => (e.guardian.linkedParentUid ? accountByUid.get(e.guardian.linkedParentUid)?.displayName : ""))
      .find((n) => n);
    const guardianName = entryName(entries);
    const displayName = guardianName || linkedAccountName || rep?.displayName || "이름 미입력";
    const appName = rep?.displayName && rep.displayName !== displayName ? rep.displayName : null;
    const relationIds = [
      ...new Set(entries.map((e) => e.guardian.relationId).filter((r): r is string => Boolean(r))),
    ];
    const phone = entries[0]?.guardian.phone || rep?.phone || "";
    return {
      key,
      phone,
      unmatched,
      entries,
      accounts: cardAccounts,
      children,
      displayName,
      appName,
      relationIds,
      hasForeignLinks,
    };
  };

  const groups = keys.map((k) => makeGroup(k, entriesByKey.get(k)!, false));
  const unmatched = [...unmatchedByKey.keys()]
    .map((k) => makeGroup(k, [], true))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "ko") || a.key.localeCompare(b.key));
  return [...groups, ...unmatched];
}

// ---------------------------------------------------------------- 필터·검색

export type GuardianFilter = "all" | "none" | "linked" | "unlinked" | "inactive" | "push";

export const GUARDIAN_FILTER_LABELS: Record<GuardianFilter, string> = {
  all: "전체",
  none: "미가입",
  linked: "연결됨",
  unlinked: "연결 해제됨",
  inactive: "비활성",
  push: "푸시 확인 필요",
};

export function groupMatchesFilter(g: GuardianGroup, f: GuardianFilter, nowMs: number): boolean {
  switch (f) {
    case "all":
      return true;
    case "none":
      return isGroupUnregistered(g);
    case "linked":
      return g.accounts.some((a) => parentAppState(a) === "linked");
    case "unlinked":
      return g.accounts.some((a) => parentAppState(a) === "unlinked");
    case "inactive":
      return g.accounts.some((a) => a.status === "inactive");
    case "push":
      return g.accounts.some((a) => parentPushState(a, nowMs) === "check");
  }
}

/**
 * 칩 숫자 — 계정 uid 기준 중복 없이(계정은 카드 1장에만 있으므로 카드를 돌며 계정을 세면 중복이 없다).
 * 미가입은 묶음 수, 전체는 카드 수.
 */
export function guardianFilterCounts(groups: readonly GuardianGroup[], nowMs: number): Record<GuardianFilter, number> {
  const out: Record<GuardianFilter, number> = { all: groups.length, none: 0, linked: 0, unlinked: 0, inactive: 0, push: 0 };
  for (const g of groups) {
    if (isGroupUnregistered(g)) out.none += 1;
    for (const a of g.accounts) {
      const st = parentAppState(a);
      if (st === "linked") out.linked += 1;
      if (st === "unlinked") out.unlinked += 1;
      if (st === "inactive") out.inactive += 1;
      if (parentPushState(a, nowMs) === "check") out.push += 1;
    }
  }
  return out;
}

export function groupMatchesSearch(g: GuardianGroup, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/\D/g, "");
  const names = [
    g.displayName,
    ...g.entries.map((e) => e.guardian.name ?? ""),
    ...g.accounts.map((a) => a.displayName),
    ...g.accounts.map((a) => a.loginId),
    ...g.children.map((c) => c.student.name),
  ];
  if (names.some((n) => n.toLowerCase().includes(q))) return true;
  if (digits.length >= 3) {
    const phones = [g.phone, ...g.accounts.map((a) => a.phone)];
    if (phones.some((p) => phoneKey(p).includes(digits))) return true;
  }
  return false;
}

/** 번호가 같은 원생(승인 시트 "번호 일치") — 보호자 항목 번호 키가 계정 번호 키와 같은 원생 */
export function studentsMatchingPhone(students: readonly StudentVM[], key: string): StudentVM[] {
  if (!key) return [];
  return students.filter((s) => s.guardians.some((g) => phoneKey(g.phone) === key));
}
