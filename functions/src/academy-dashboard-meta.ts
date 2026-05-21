import * as admin from "firebase-admin";
import { FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";

type MemberStatus =
  | "invitation_needed"
  | "invitation_sent"
  | "pending_registration"
  | "active"
  | "inactive";

export const ACADEMY_DASHBOARD_STATS_SCHEMA_VERSION = 1;
export const ACADEMY_ADMIN_INBOX_SCHEMA_VERSION = 1;

const firestoreTriggerOpts = { region: "asia-northeast3" as const };

function statsRef(db: admin.firestore.Firestore, academyId: string) {
  return db.doc(`academies/${academyId}/meta/dashboardStats`);
}

function inboxCol(db: admin.firestore.Firestore, academyId: string) {
  return db.collection(`academies/${academyId}/adminInbox`);
}

function readDisplayName(data: DocumentData): string {
  const n = data.displayName;
  return typeof n === "string" && n.trim() ? n.trim() : "이름 미입력";
}

function readEmail(data: DocumentData): string {
  return typeof data.email === "string" ? data.email : "";
}

function inviteExpiresAtFromData(data: DocumentData, ttlMs: number): Timestamp | null {
  const exp = data.invitationExpiresAt;
  if (exp instanceof Timestamp) return exp;
  const invited = data.invitedAt;
  if (invited instanceof Timestamp) {
    return Timestamp.fromMillis(invited.toMillis() + ttlMs);
  }
  return null;
}

const TEACHER_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const PARENT_INVITE_TTL_MS = TEACHER_INVITE_TTL_MS;

async function countCollection(
  db: admin.firestore.Firestore,
  academyId: string,
  sub: "teachers" | "parents" | "students",
  status?: MemberStatus,
): Promise<number> {
  let q: admin.firestore.Query = db.collection(`academies/${academyId}/${sub}`);
  if (status) {
    q = q.where("status", "==", status);
  }
  const snap = await q.count().get();
  return snap.data().count;
}

/** 홈 요약·히트맵용 집계 — 학원 규모에서 쓰기 시 전체 재계산(정합성 우선) */
export async function reconcileAcademyDashboardStats(
  db: admin.firestore.Firestore,
  academyId: string,
): Promise<void> {
  const [
    teachers,
    parents,
    students,
    teachersPending,
    teachersInviteNeeded,
    teachersInviteSent,
    parentsPending,
    parentsInviteNeeded,
    parentsInviteSent,
  ] = await Promise.all([
    countCollection(db, academyId, "teachers"),
    countCollection(db, academyId, "parents"),
    countCollection(db, academyId, "students"),
    countCollection(db, academyId, "teachers", "pending_registration"),
    countCollection(db, academyId, "teachers", "invitation_needed"),
    countCollection(db, academyId, "teachers", "invitation_sent"),
    countCollection(db, academyId, "parents", "pending_registration"),
    countCollection(db, academyId, "parents", "invitation_needed"),
    countCollection(db, academyId, "parents", "invitation_sent"),
  ]);

  await statsRef(db, academyId).set({
    schemaVersion: ACADEMY_DASHBOARD_STATS_SCHEMA_VERSION,
    teachers,
    parents,
    students,
    teachersPending,
    teachersInviteNeeded,
    teachersInviteSent,
    parentsPending,
    parentsInviteNeeded,
    parentsInviteSent,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function syncTeacherInbox(
  db: admin.firestore.Firestore,
  academyId: string,
  teacherId: string,
  after: DocumentData | undefined,
): Promise<void> {
  const col = inboxCol(db, academyId);
  const pendingRef = col.doc(`t-pending-${teacherId}`);
  const inviteRef = col.doc(`t-invite-${teacherId}`);

  if (!after) {
    await Promise.all([pendingRef.delete(), inviteRef.delete()]);
    return;
  }

  const status = (after.status as MemberStatus) || "invitation_needed";
  const base = {
    schemaVersion: ACADEMY_ADMIN_INBOX_SCHEMA_VERSION,
    entityType: "teacher" as const,
    entityId: teacherId,
    displayName: readDisplayName(after),
    email: readEmail(after),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (status === "pending_registration") {
    await inviteRef.delete();
    await pendingRef.set({
      ...base,
      kind: "pending_registration",
      createdAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  if (status === "invitation_sent") {
    await pendingRef.delete();
    const invitationExpiresAt = inviteExpiresAtFromData(after, TEACHER_INVITE_TTL_MS);
    await inviteRef.set({
      ...base,
      kind: "invitation_sent",
      invitedAt: after.invitedAt ?? null,
      invitationExpiresAt,
      createdAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  await Promise.all([pendingRef.delete(), inviteRef.delete()]);
}

async function syncParentInbox(
  db: admin.firestore.Firestore,
  academyId: string,
  parentId: string,
  after: DocumentData | undefined,
): Promise<void> {
  const col = inboxCol(db, academyId);
  const pendingRef = col.doc(`p-pending-${parentId}`);
  const inviteRef = col.doc(`p-invite-${parentId}`);

  if (!after) {
    await Promise.all([pendingRef.delete(), inviteRef.delete()]);
    return;
  }

  const status = (after.status as MemberStatus) || "invitation_needed";
  const base = {
    schemaVersion: ACADEMY_ADMIN_INBOX_SCHEMA_VERSION,
    entityType: "parent" as const,
    entityId: parentId,
    displayName: readDisplayName(after),
    email: readEmail(after),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (status === "pending_registration") {
    await inviteRef.delete();
    await pendingRef.set({
      ...base,
      kind: "pending_registration",
      createdAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  if (status === "invitation_sent") {
    await pendingRef.delete();
    const invitationExpiresAt = inviteExpiresAtFromData(after, PARENT_INVITE_TTL_MS);
    await inviteRef.set({
      ...base,
      kind: "invitation_sent",
      invitedAt: after.invitedAt ?? null,
      invitationExpiresAt,
      createdAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  await Promise.all([pendingRef.delete(), inviteRef.delete()]);
}

export async function reconcileAcademyAdminInbox(
  db: admin.firestore.Firestore,
  academyId: string,
): Promise<void> {
  const [teachersSnap, parentsSnap] = await Promise.all([
    db.collection(`academies/${academyId}/teachers`).get(),
    db.collection(`academies/${academyId}/parents`).get(),
  ]);

  await Promise.all([
    ...teachersSnap.docs.map((d) => syncTeacherInbox(db, academyId, d.id, d.data())),
    ...parentsSnap.docs.map((d) => syncParentInbox(db, academyId, d.id, d.data())),
  ]);
}

export async function onAcademyTeacherDashboardMetaChange(
  db: admin.firestore.Firestore,
  academyId: string,
  teacherId: string,
  after: DocumentData | undefined,
): Promise<void> {
  await Promise.all([
    reconcileAcademyDashboardStats(db, academyId),
    syncTeacherInbox(db, academyId, teacherId, after),
  ]);
}

export async function onAcademyParentDashboardMetaChange(
  db: admin.firestore.Firestore,
  academyId: string,
  parentId: string,
  after: DocumentData | undefined,
): Promise<void> {
  await Promise.all([
    reconcileAcademyDashboardStats(db, academyId),
    syncParentInbox(db, academyId, parentId, after),
  ]);
}

export async function onAcademyStudentDashboardMetaChange(
  db: admin.firestore.Firestore,
  academyId: string,
): Promise<void> {
  await reconcileAcademyDashboardStats(db, academyId);
}

/** 선생님 멤버십 변경 — activation 미러는 `user-activation-mirror`에서 처리 */
export const onAcademyTeacherDashboardMetaWritten = onDocumentWritten(
  { document: "academies/{academyId}/teachers/{teacherId}", ...firestoreTriggerOpts },
  async (event) => {
    const academyId = event.params.academyId;
    const teacherId = event.params.teacherId;
    const after = event.data?.after?.data();
    const db = admin.firestore();
    try {
      await onAcademyTeacherDashboardMetaChange(db, academyId, teacherId, after);
    } catch (e) {
      logger.error("onAcademyTeacherDashboardMetaWritten failed", { e, academyId, teacherId });
      throw e;
    }
  },
);

export const onAcademyParentDashboardMetaWritten = onDocumentWritten(
  { document: "academies/{academyId}/parents/{parentId}", ...firestoreTriggerOpts },
  async (event) => {
    const academyId = event.params.academyId;
    const parentId = event.params.parentId;
    const after = event.data?.after?.data();
    const db = admin.firestore();
    try {
      await onAcademyParentDashboardMetaChange(db, academyId, parentId, after);
    } catch (e) {
      logger.error("onAcademyParentDashboardMetaWritten failed", { e, academyId, parentId });
      throw e;
    }
  },
);

export const onAcademyStudentDashboardMetaWritten = onDocumentWritten(
  { document: "academies/{academyId}/students/{studentId}", ...firestoreTriggerOpts },
  async (event) => {
    const academyId = event.params.academyId;
    const db = admin.firestore();
    try {
      await onAcademyStudentDashboardMetaChange(db, academyId);
    } catch (e) {
      logger.error("onAcademyStudentDashboardMetaWritten failed", { e, academyId });
      throw e;
    }
  },
);

function assertAdmin(request: { auth?: { token?: Record<string, unknown> } }): void {
  if (request.auth?.token?.admin !== true) {
    throw new HttpsError("permission-denied", "관리자만 실행할 수 있습니다.");
  }
}

/** 운영 백필 — stats·inbox 재구성 */
export const adminReconcileAcademyDashboardMeta = onCall(async (request) => {
  assertAdmin(request);
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  if (!academyId) {
    throw new HttpsError("invalid-argument", "academyId가 필요합니다.");
  }

  const db = admin.firestore();
  const academySnap = await db.doc(`academies/${academyId}`).get();
  if (!academySnap.exists) {
    throw new HttpsError("not-found", "학원을 찾을 수 없습니다.");
  }

  await reconcileAcademyDashboardStats(db, academyId);
  await reconcileAcademyAdminInbox(db, academyId);

  logger.info("adminReconcileAcademyDashboardMeta", { academyId });
  return { ok: true as const, academyId };
});
