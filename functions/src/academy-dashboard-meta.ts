import * as admin from "firebase-admin";
import { FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";

type MemberStatus =
  | "pending_setup"
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

async function countCollection(
  db: admin.firestore.Firestore,
  academyId: string,
  sub: "staff" | "parents" | "students",
  status?: MemberStatus,
): Promise<number> {
  let q: admin.firestore.Query = db.collection(`academies/${academyId}/${sub}`);
  if (status) {
    q = q.where("status", "==", status);
  }
  const snap = await q.count().get();
  return snap.data().count;
}

/** 학부모 가입 승인 대기 — 연결된 적 없는 `pending_approval`(연결 해제로 돌아온 계정은 `approvedAt`이 있어 빠짐) */
export function isParentAwaitingApproval(data: DocumentData | undefined): boolean {
  return data?.status === "pending_approval" && data?.approvedAt == null;
}

async function countParentsAwaitingApproval(
  db: admin.firestore.Firestore,
  academyId: string,
): Promise<number> {
  const snap = await db
    .collection(`academies/${academyId}/parents`)
    .where("status", "==", "pending_approval")
    .where("approvedAt", "==", null)
    .count()
    .get();
  return snap.data().count;
}

/**
 * 학원 문서가 있는지 — 학원 삭제(cascade)가 멤버·학생을 지우면 그 삭제 트리거가 뒤늦게 돌아
 * 지워진 학원 아래에 집계·inbox 문서를 다시 만들 수 있어, 쓰기 직전에 확인한다.
 * (확인 직후 학원이 지워지는 좁은 틈은 남음)
 */
async function academyExists(db: admin.firestore.Firestore, academyId: string): Promise<boolean> {
  return (await db.doc(`academies/${academyId}`).get()).exists;
}

/** 홈 요약·히트맵용 집계 — 학원 규모에서 쓰기 시 전체 재계산(정합성 우선). 학원 문서가 없으면 쓰지 않음 */
export async function reconcileAcademyDashboardStats(
  db: admin.firestore.Firestore,
  academyId: string,
): Promise<void> {
  const [
    teachers,
    parents,
    students,
    teachersPending,
    teachersPendingSetup,
    teachersInviteNeeded,
    teachersInviteSent,
    parentsPending,
  ] = await Promise.all([
    countCollection(db, academyId, "staff"),
    countCollection(db, academyId, "parents"),
    countCollection(db, academyId, "students"),
    countCollection(db, academyId, "staff", "pending_registration"),
    countCollection(db, academyId, "staff", "pending_setup"),
    countCollection(db, academyId, "staff", "invitation_needed"),
    countCollection(db, academyId, "staff", "invitation_sent"),
    countParentsAwaitingApproval(db, academyId),
  ]);

  if (!(await academyExists(db, academyId))) return;
  await statsRef(db, academyId).set({
    schemaVersion: ACADEMY_DASHBOARD_STATS_SCHEMA_VERSION,
    teachers,
    parents,
    students,
    teachersPending: teachersPending + teachersPendingSetup,
    teachersInviteNeeded,
    teachersInviteSent,
    parentsPending,
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

  if (status === "pending_registration" || status === "pending_setup") {
    await inviteRef.delete();
    if (!(await academyExists(db, academyId))) return;
    await pendingRef.set({
      ...base,
      kind: "pending_registration",
      createdAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  if (status === "invitation_sent") {
    await pendingRef.delete();
    if (!(await academyExists(db, academyId))) return;
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

/** 학부모 inbox — 가입 승인 대기(`parent_pending_approval`)만. 승인·연결·거절되면 지우고, 연결 해제로 돌아와도 다시 만들지 않음 */
async function syncParentInbox(
  db: admin.firestore.Firestore,
  academyId: string,
  parentId: string,
  after: DocumentData | undefined,
): Promise<void> {
  const col = inboxCol(db, academyId);
  const approvalRef = col.doc(`p-approval-${parentId}`);
  // 이메일 초청 시절 항목(폐지) — 남아 있으면 정리
  const legacyRefs = [col.doc(`p-pending-${parentId}`), col.doc(`p-invite-${parentId}`)];

  if (!isParentAwaitingApproval(after)) {
    await Promise.all([approvalRef, ...legacyRefs].map((r) => r.delete()));
    return;
  }
  await Promise.all(legacyRefs.map((r) => r.delete()));
  if (!(await academyExists(db, academyId))) return;
  const existing = await approvalRef.get();
  await approvalRef.set({
    schemaVersion: ACADEMY_ADMIN_INBOX_SCHEMA_VERSION,
    entityType: "parent" as const,
    entityId: parentId,
    displayName: readDisplayName(after!),
    email: readEmail(after!),
    kind: "parent_pending_approval",
    createdAt: existing.exists ? existing.get("createdAt") : FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function reconcileAcademyAdminInbox(
  db: admin.firestore.Firestore,
  academyId: string,
): Promise<void> {
  const [teachersSnap, parentsSnap] = await Promise.all([
    db.collection(`academies/${academyId}/staff`).get(),
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
  { document: "academies/{academyId}/staff/{teacherId}", ...firestoreTriggerOpts },
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
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    // 연결 목록·푸시 수신 상태처럼 집계·inbox와 무관한 갱신은 건너뜀
    if (
      before &&
      after &&
      before.status === after.status &&
      (before.approvedAt == null) === (after.approvedAt == null) &&
      before.displayName === after.displayName
    ) {
      return;
    }
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
    // 집계가 쓰는 학생 값은 총수뿐 — 생성·삭제만 처리(반 배정·원비 수정 등 학생 수정마다 count 쿼리를 돌리지 않게)
    if (event.data?.before?.exists === event.data?.after?.exists) return;
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
