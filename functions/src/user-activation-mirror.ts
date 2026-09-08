import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import { purgeUserFirestoreData, syncUserAdminProfile } from "./lib/firestore-cleanup";

type TeacherStatus =
  | "pending_setup"
  | "invitation_needed"
  | "invitation_sent"
  | "pending_registration"
  | "active"
  | "inactive";

type ParentStatus =
  | TeacherStatus
  | "pending_email_verification";

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
  "pending_registration",
  "invitation_sent",
  "inactive",
  "invitation_needed",
];

function teacherDocAcademyId(ref: admin.firestore.DocumentReference): string | null {
  const m = ref.path.match(/^academies\/([^/]+)\/teachers\//);
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
    .collectionGroup("teachers")
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

  const snaps = await db.collectionGroup("teachers").where("authUid", "==", uid).limit(25).get();

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

/** Callable·트리거에서 동일 스냅샷을 `users/{uid}/serverMirror/activation`에 기록 */
export async function reconcileUserActivationMirror(
  db: admin.firestore.Firestore,
  authUid: string,
  source: "trigger" | "reconcile" | "bootstrap",
): Promise<{ teacher: RoleActivationSlice; parent: RoleActivationSlice }> {
  const [teacher, parent] = await Promise.all([
    computeTeacherActivationForUid(db, authUid),
    computeParentActivationForUid(db, authUid),
  ]);

  if (!(await authUserExists(authUid))) {
    await purgeUserFirestoreData(db, authUid);
    return { teacher, parent };
  }

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
    const ownsAcademy = await db
      .collection("academies")
      .where("ownerUid", "==", authUid)
      .limit(1)
      .get();
    if (ownsAcademy.empty) {
      await purgeUserFirestoreData(db, authUid);
    }
    return { teacher, parent };
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

  return { teacher, parent };
}

function authUidsFromMembershipChange(
  before: admin.firestore.DocumentSnapshot | undefined,
  after: admin.firestore.DocumentSnapshot | undefined,
): string[] {
  const uids = new Set<string>();
  for (const snap of [before, after]) {
    if (!snap?.exists) continue;
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
  { document: "academies/{academyId}/teachers/{teacherId}", ...firestoreTriggerOpts },
  async (event) => {
    const uids = authUidsFromMembershipChange(event.data?.before, event.data?.after);
    if (uids.length === 0) return;

    const db = admin.firestore();
    try {
      await Promise.all(uids.map((uid) => reconcileUserActivationMirror(db, uid, "trigger")));
    } catch (e) {
      logger.error("onTeacherMembershipWritten: mirror reconcile failed", { e, uids });
      throw e;
    }
  },
);

export const onParentMembershipWritten = onDocumentWritten(
  { document: "academies/{academyId}/parents/{parentId}", ...firestoreTriggerOpts },
  async (event) => {
    const uids = authUidsFromMembershipChange(event.data?.before, event.data?.after);
    if (uids.length === 0) return;

    const db = admin.firestore();
    try {
      await Promise.all(uids.map((uid) => reconcileUserActivationMirror(db, uid, "trigger")));
    } catch (e) {
      logger.error("onParentMembershipWritten: mirror reconcile failed", { e, uids });
      throw e;
    }
  },
);
