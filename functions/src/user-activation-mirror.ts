import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import { hasOwnerRole } from "./lib/account-use";
import { purgeUserFirestoreData, syncUserAdminProfile } from "./lib/firestore-cleanup";

type TeacherStatus =
  | "pending_setup"
  | "invitation_needed"
  | "invitation_sent"
  | "pending_registration"
  | "active"
  | "inactive";

/** 학부모 계정 상태(`lib/parent-links.ts` `ParentAccountStatus`) — 이메일 초청 상태는 2-C에서 폐지 */
type ParentStatus =
  | "pending_email_verification"
  | "pending_setup"
  | "pending_approval"
  | "active"
  | "inactive";

const TEACHER_STATUS_PRIORITY: TeacherStatus[] = [
  "pending_setup",
  "pending_registration",
  "invitation_sent",
  "inactive",
  "invitation_needed",
];

const PARENT_STATUS_PRIORITY: ParentStatus[] = [
  "pending_email_verification",
  "pending_setup",
  "pending_approval",
  "inactive",
];

function teacherDocAcademyId(ref: admin.firestore.DocumentReference): string | null {
  const m = ref.path.match(/^academies\/([^/]+)\/staff\//);
  return m ? m[1] : null;
}

function parentDocAcademyId(ref: admin.firestore.DocumentReference): string | null {
  const m = ref.path.match(/^academies\/([^/]+)\/parents\//);
  return m ? m[1] : null;
}

export type RoleActivationSlice = {
  anyActive: boolean;
  primaryStatus: string | null;
  primaryAcademyId: string | null;
};

export async function computeTeacherActivationForUid(
  db: admin.firestore.Firestore,
  uid: string,
): Promise<RoleActivationSlice> {
  const activeSnap = await db
    .collectionGroup("staff")
    .where("authUid", "==", uid)
    .where("status", "==", "active")
    .limit(1)
    .get();

  if (!activeSnap.empty) {
    const d = activeSnap.docs[0]!;
    return {
      anyActive: true,
      primaryStatus: "active",
      primaryAcademyId: teacherDocAcademyId(d.ref),
    };
  }

  const snaps = await db.collectionGroup("staff").where("authUid", "==", uid).limit(25).get();

  if (snaps.empty) {
    return {
      anyActive: false,
      primaryStatus: null,
      primaryAcademyId: null,
    };
  }

  const memberships = snaps.docs.map((d) => {
    const status = d.data().status as TeacherStatus;
    const academyId = teacherDocAcademyId(d.ref);
    return { status, academyId };
  });

  const primary = memberships.find((m) => TEACHER_STATUS_PRIORITY.includes(m.status));
  return {
    anyActive: false,
    primaryStatus: primary?.status ?? null,
    primaryAcademyId: primary?.academyId ?? null,
  };
}

export async function computeParentActivationForUid(
  db: admin.firestore.Firestore,
  uid: string,
): Promise<RoleActivationSlice> {
  const activeSnap = await db
    .collectionGroup("parents")
    .where("authUid", "==", uid)
    .where("status", "==", "active")
    .limit(1)
    .get();

  if (!activeSnap.empty) {
    const d = activeSnap.docs[0]!;
    return {
      anyActive: true,
      primaryStatus: "active",
      primaryAcademyId: parentDocAcademyId(d.ref),
    };
  }

  const snaps = await db.collectionGroup("parents").where("authUid", "==", uid).limit(25).get();

  if (snaps.empty) {
    return {
      anyActive: false,
      primaryStatus: null,
      primaryAcademyId: null,
    };
  }

  const memberships = snaps.docs.map((d) => {
    const status = d.data().status as ParentStatus;
    const academyId = parentDocAcademyId(d.ref);
    return { status, academyId };
  });

  const primary = memberships.find((m) => PARENT_STATUS_PRIORITY.includes(m.status));
  return {
    anyActive: false,
    primaryStatus: primary?.status ?? null,
    primaryAcademyId: primary?.academyId ?? null,
  };
}

async function authUserExists(authUid: string): Promise<boolean> {
  try {
    await admin.auth().getUser(authUid);
    return true;
  } catch {
    return false;
  }
}

type ActivationSlices = { teacher: RoleActivationSlice; parent: RoleActivationSlice };

/** 쓴 값과 다시 계산한 값 비교용 */
export function activationSlicesKey(s: ActivationSlices): string {
  const k = (x: RoleActivationSlice) => [x.anyActive, x.primaryStatus, x.primaryAcademyId];
  return JSON.stringify([k(s.teacher), k(s.parent)]);
}

/** 쓰고 다시 확인하는 최대 횟수 — 상태가 계속 바뀌는 드문 경우에도 끝나게 */
export const RECONCILE_MAX_ROUNDS = 3;

/**
 * Callable·트리거에서 동일 스냅샷을 `users/{uid}/serverMirror/activation`과 Custom Claims에 기록.
 *
 * **늦은 덮어쓰기 가드(2-L L-3 보강)**: 계산(문서 읽기)과 쓰기(클레임·미러) 사이에 상태가 바뀌면, 먼저 시작해 늦게 끝난 실행이
 * 옛 상태를 마지막에 쓸 수 있다(예: 직원 가입 → 자동 활성, 학부모 가입 → 자동 연결처럼 생성과 활성이 한 요청에서 일어나
 * 두 트리거가 겹칠 때). 막는 순서:
 * ① 트리거는 시작할 때 이벤트 뒤 문서가 또 바뀌었으면 건너뜀(`membershipEventSuperseded`)
 * ② 클레임을 쓰기 **직전**에 다시 확인(`isCurrent`) — 그 사이 바뀌었으면 쓰지 않음(뒤 이벤트의 트리거가 씀)
 * ③ 쓴 뒤 **다시 계산해 쓴 값과 다르면 한 번 더 쓴다**(최대 `RECONCILE_MAX_ROUNDS`) — 마지막으로 쓴 실행은 쓴 뒤의 문서를 다시 읽으므로
 *    그때까지 커밋된 최신 상태로 끝난다.
 * Auth 사용자 확인은 계산 전에 해서, 계산과 클레임 쓰기 사이에 다른 왕복이 없게 한다(옛 값을 쓸 수 있는 창을 줄임).
 */
export async function reconcileUserActivationMirror(
  db: admin.firestore.Firestore,
  authUid: string,
  source: "trigger" | "reconcile" | "bootstrap",
  opts: {
    /** 이미 계산해 둔 값으로 시작(스모크가 "먼저 계산하고 늦게 쓰는 실행"을 재현할 때) — 보통은 비움 */
    precomputed?: ActivationSlices;
    /** 트리거 — 클레임을 쓰기 직전 이 이벤트가 아직 최신인지(아니면 이 실행은 쓰지 않고 끝냄) */
    isCurrent?: () => Promise<boolean>;
  } = {},
): Promise<ActivationSlices> {
  const compute = async (): Promise<ActivationSlices> => {
    const [teacher, parent] = await Promise.all([
      computeTeacherActivationForUid(db, authUid),
      computeParentActivationForUid(db, authUid),
    ]);
    return { teacher, parent };
  };
  if (!(await authUserExists(authUid))) {
    const slices = await compute();
    await purgeUserFirestoreData(db, authUid);
    return slices;
  }
  let slices = opts.precomputed ?? (await compute());
  for (let round = 1; ; round += 1) {
    if (round === 1 && opts.isCurrent && !(await opts.isCurrent())) {
      logger.info("reconcileUserActivationMirror: 계산 뒤 이벤트가 낡음 — 쓰지 않음(뒤 이벤트가 맞춤)", { authUid, source });
      return slices;
    }
    const done = await writeUserActivation(db, authUid, slices, source);
    if (done) return slices;
    const fresh = await compute();
    if (activationSlicesKey(fresh) === activationSlicesKey(slices)) return slices;
    if (round >= RECONCILE_MAX_ROUNDS) {
      logger.warn("reconcileUserActivationMirror: 상태가 계속 바뀜 — 다음 쓰기의 트리거에 맡김", { authUid, source });
      return fresh;
    }
    logger.info("reconcileUserActivationMirror: 쓰는 사이 상태가 바뀜 — 다시 씀", { authUid, source, round });
    slices = fresh;
  }
}

/** 클레임·미러 한 번 쓰기 — 계정이 없거나 멤버십이 없어 정리하고 끝났으면 true(다시 확인 안 함) */
async function writeUserActivation(
  db: admin.firestore.Firestore,
  authUid: string,
  { teacher, parent }: ActivationSlices,
  source: "trigger" | "reconcile" | "bootstrap",
): Promise<boolean> {
  /**
   * 클라이언트가 매 로그인마다 콜러블로 재확인하지 않고 ID 토큰 클레임만으로
   * 역할을 판별할 수 있도록, 미러 갱신 시점에 Custom Claims도 함께 최신화한다.
   * 우선순위는 클라이언트 `resolveKnownSessionDashboardPath`와 동일하게 teacher > parent.
   * 멤버십이 전혀 없으면(owner/academy 계정일 수 있음) 기존 클레임을 건드리지 않는다.
   */
  if (teacher.primaryStatus !== null) {
    await admin.auth().setCustomUserClaims(authUid, {
      role: "teacher",
      academyId: teacher.primaryAcademyId,
      membershipStatus: teacher.primaryStatus,
    });
  } else if (parent.primaryStatus !== null) {
    await admin.auth().setCustomUserClaims(authUid, {
      role: "parent",
      academyId: parent.primaryAcademyId,
      membershipStatus: parent.primaryStatus,
    });
  }

  const noMembership = teacher.primaryStatus === null && parent.primaryStatus === null;
  if (noMembership) {
    const [ownsAcademy, ownerRole] = await Promise.all([
      db.collection("academies").where("ownerUid", "==", authUid).limit(1).get(),
      hasOwnerRole(db, authUid),
    ]);
    // 2-N: 학원을 모두 지운 원장(원장 계정 표시만 남음)의 `users` 문서는 지우지 않는다
    if (ownsAcademy.empty && !ownerRole) {
      await purgeUserFirestoreData(db, authUid);
    }
    return true;
  }

  const ref = db.doc(`users/${authUid}/serverMirror/activation`);
  await ref.set(
    {
      schemaVersion: 1,
      teacher,
      parent,
      updatedAt: FieldValue.serverTimestamp(),
      source,
    },
    { merge: true },
  );
  await syncUserAdminProfile(db, authUid);
  return false;
}

/**
 * 이 이벤트 뒤에 같은 문서가 또 바뀌었는지(상태·계정) — 그러면 이 실행은 건너뛴다(늦은 덮어쓰기 가드의 첫 단계).
 * 뒤의 쓰기가 자기 트리거로 최신 상태를 맞추므로 옛 이벤트가 클레임을 쓸 필요가 없다. 삭제 이벤트는 항상 처리.
 */
async function membershipEventSuperseded(after: admin.firestore.DocumentSnapshot | undefined): Promise<boolean> {
  if (!after?.exists) return false;
  const current = await after.ref.get();
  if (!current.exists) return true;
  return current.get("status") !== after.get("status") || current.get("authUid") !== after.get("authUid");
}

function authUidsFromMembershipChange(
  before: admin.firestore.DocumentSnapshot | undefined,
  after: admin.firestore.DocumentSnapshot | undefined,
): string[] {
  const uids = new Set<string>();
  for (const snap of [before, after]) {
    if (!snap?.exists) continue;
    // 계정 없이 인사 정보만 있는 직원(문서 ID 임의) — 대응하는 Auth 사용자가 없음
    if (snap.get("status") === "no_account") continue;
    if (snap.id) {
      uids.add(snap.id);
    }
    const au = snap.get("authUid");
    if (typeof au === "string" && au.length > 0) {
      uids.add(au);
    }
  }
  return [...uids];
}

const firestoreTriggerOpts = { region: "asia-northeast3" as const };

export const onTeacherMembershipWritten = onDocumentWritten(
  { document: "academies/{academyId}/staff/{teacherId}", ...firestoreTriggerOpts },
  async (event) => {
    const uids = authUidsFromMembershipChange(event.data?.before, event.data?.after);
    if (uids.length === 0) return;
    if (await membershipEventSuperseded(event.data?.after)) return;

    const db = admin.firestore();
    try {
      const after = event.data?.after;
      const isCurrent = async () => !(await membershipEventSuperseded(after));
      await Promise.all(uids.map((uid) => reconcileUserActivationMirror(db, uid, "trigger", { isCurrent })));
    } catch (e) {
      logger.error("onTeacherMembershipWritten: mirror reconcile failed", { e, uids });
      throw e;
    }
  },
);

/**
 * 학부모 문서 생성·삭제·상태(status)·authUid 변경 때만 미러·클레임을 다시 계산한다
 * (연결 목록·푸시 수신 상태 갱신마다 클레임을 다시 쓰지 않게).
 */
function parentMembershipChanged(
  before: admin.firestore.DocumentSnapshot | undefined,
  after: admin.firestore.DocumentSnapshot | undefined,
): boolean {
  if (!before?.exists || !after?.exists) return Boolean(before?.exists || after?.exists);
  return before.get("status") !== after.get("status") || before.get("authUid") !== after.get("authUid");
}

export const onParentMembershipWritten = onDocumentWritten(
  { document: "academies/{academyId}/parents/{parentId}", ...firestoreTriggerOpts },
  async (event) => {
    if (!parentMembershipChanged(event.data?.before, event.data?.after)) return;
    const uids = authUidsFromMembershipChange(event.data?.before, event.data?.after);
    if (uids.length === 0) return;
    if (await membershipEventSuperseded(event.data?.after)) return;

    const db = admin.firestore();
    try {
      const after = event.data?.after;
      const isCurrent = async () => !(await membershipEventSuperseded(after));
      await Promise.all(uids.map((uid) => reconcileUserActivationMirror(db, uid, "trigger", { isCurrent })));
    } catch (e) {
      logger.error("onParentMembershipWritten: mirror reconcile failed", { e, uids });
      throw e;
    }
  },
);
