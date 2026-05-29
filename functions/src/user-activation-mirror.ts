import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";

type TeacherStatus =
  | "pending_setup"
  | "invitation_needed"
  | "invitation_sent"
  | "pending_registration"
  | "active"
  | "inactive";

type ParentStatus = TeacherStatus;

const TEACHER_STATUS_PRIORITY: TeacherStatus[] = [
  "pending_setup",
  "pending_registration",
  "invitation_sent",
  "inactive",
  "invitation_needed",
];

const PARENT_STATUS_PRIORITY: ParentStatus[] = [
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
