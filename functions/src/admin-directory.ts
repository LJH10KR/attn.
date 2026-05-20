import * as admin from "firebase-admin";
import type { DocumentReference } from "firebase-admin/firestore";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { reconcileUserActivationMirror } from "./user-activation-mirror";

function assertAdmin(request: {
  auth?: { uid: string; token?: Record<string, unknown> } | null;
}): void {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const isAdmin = request.auth?.token && request.auth.token.admin === true;
  if (!isAdmin) {
    throw new HttpsError("permission-denied", "관리자 권한이 없습니다.");
  }
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function chunkArray<T>(arr: T[], chunkSize: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize) out.push(arr.slice(i, i + chunkSize));
  return out;
}

async function authUserHasAdminClaim(uid: string): Promise<boolean> {
  try {
    const u = await admin.auth().getUser(uid);
    const c = u.customClaims as Record<string, unknown> | undefined;
    return Boolean(c && c.admin === true);
  } catch {
    return false;
  }
}

async function safeDeleteAuthUser(uid: string, context: string): Promise<void> {
  if (!uid || uid.startsWith("academy_")) return;
  if (await authUserHasAdminClaim(uid)) {
    logger.warn(`${context}: skip admin auth user`, { uid });
    return;
  }
  try {
    await admin.auth().deleteUser(uid);
  } catch (e) {
    logger.warn(`${context}: deleteUser skipped`, { uid, e });
  }
}

async function deleteAcademyFirestoreDocs(
  db: admin.firestore.Firestore,
  academyId: string,
): Promise<void> {
  const academyTeachersRef = db.collection(`academies/${academyId}/teachers`);
  const academyParentsRef = db.collection(`academies/${academyId}/parents`);
  const academyStudentsRef = db.collection(`academies/${academyId}/students`);
  const secretsLoginRef = db.doc(`academies/${academyId}/secrets/login`);
  const academyRef = db.doc(`academies/${academyId}`);

  const [teachersSnap, parentsSnap, studentsSnap, secretsSnap] = await Promise.all([
    academyTeachersRef.get(),
    academyParentsRef.get(),
    academyStudentsRef.get(),
    secretsLoginRef.get(),
  ]);

  const deleteOps: DocumentReference[] = [];
  teachersSnap.docs.forEach((d) => deleteOps.push(d.ref));
  parentsSnap.docs.forEach((d) => deleteOps.push(d.ref));
  studentsSnap.docs.forEach((d) => deleteOps.push(d.ref));
  if (secretsSnap.exists) deleteOps.push(secretsLoginRef);
  deleteOps.push(academyRef);

  const chunkSize = 400;
  for (const c of chunkArray(deleteOps, chunkSize)) {
    const batch = db.batch();
    for (const ref of c) batch.delete(ref);
    await batch.commit();
  }
}

function memberAuthUid(data: FirebaseFirestore.DocumentData, docId: string): string {
  const a = data.authUid;
  return typeof a === "string" && a.length > 0 ? a : docId;
}

async function deleteUserDocumentAndKnownSubcollections(
  db: admin.firestore.Firestore,
  userId: string,
): Promise<void> {
  const subPaths = ["pushSubscriptions", "dashboardBellItems"] as const;
  for (const sub of subPaths) {
    const snap = await db.collection(`users/${userId}/${sub}`).get();
    for (const c of chunkArray(snap.docs, 400)) {
      const batch = db.batch();
      for (const d of c) batch.delete(d.ref);
      await batch.commit();
    }
  }
  try {
    await db.doc(`users/${userId}`).delete();
  } catch (e) {
    logger.warn("deleteUserDocumentAndKnownSubcollections: user doc delete skipped", { userId, e });
  }
}

async function stripTeacherFromStudents(
  db: admin.firestore.Firestore,
  academyId: string,
  teacherUid: string,
): Promise<void> {
  const studentsSnap = await db.collection(`academies/${academyId}/students`).get();
  const updates: Array<{ ref: DocumentReference; patch: Record<string, unknown> }> = [];

  for (const doc of studentsSnap.docs) {
    const data = doc.data();
    const arr = Array.isArray(data.assignedTeacherUids)
      ? (data.assignedTeacherUids as string[])
      : [];
    const legacy =
      typeof data.assignedTeacherUid === "string" ? (data.assignedTeacherUid as string) : null;
    const next = arr.filter((id) => id !== teacherUid);
    let patch: Record<string, unknown> | null = null;
    if (next.length !== arr.length) {
      patch = {
        assignedTeacherUids: next,
        updatedAt: FieldValue.serverTimestamp(),
      };
    }
    if (legacy === teacherUid) {
      patch = {
        ...(patch ?? { updatedAt: FieldValue.serverTimestamp() }),
        assignedTeacherUid: FieldValue.delete(),
      };
    }
    if (patch) updates.push({ ref: doc.ref, patch });
  }

  for (const chunk of chunkArray(updates, 400)) {
    const batch = db.batch();
    for (const u of chunk) batch.update(u.ref, u.patch);
    await batch.commit();
  }
}

export type AdminDirectoryMember = {
  docId: string;
  authUid: string;
  email: string;
  displayName: string;
  status: string;
};

export type AdminDirectoryAcademy = {
  academyId: string;
  name: string;
  ownerUid: string;
  ownerEmail: string | null;
  ownerDisplayName: string | null;
  teachers: AdminDirectoryMember[];
  parents: AdminDirectoryMember[];
};

/**
 * 관리자용 — 학원별 오너·선생님·학부모 목록(이메일 테스트 정리용).
 * Firestore `academies` 최신순 상한 내에서만 조회합니다.
 */
export const listAdminUserDirectory = onCall(async (request) => {
  assertAdmin(request as unknown as { auth?: { uid: string; token?: Record<string, unknown> } | null });

  const maxAcademies = clampInt(request.data?.maxAcademies, 60, 1, 100);
  const db = admin.firestore();

  let academySnaps: FirebaseFirestore.QueryDocumentSnapshot[];
  try {
    const q = await db
      .collection("academies")
      .orderBy("createdAt", "desc")
      .limit(maxAcademies)
      .get();
    academySnaps = q.docs;
  } catch (e) {
    logger.warn("listAdminUserDirectory: orderBy createdAt failed, fallback without order", { e });
    const q = await db.collection("academies").limit(maxAcademies).get();
    academySnaps = q.docs;
  }

  const ownerUids = new Set<string>();
  for (const d of academySnaps) {
    const ou = d.get("ownerUid");
    if (typeof ou === "string" && ou) ownerUids.add(ou);
  }

  const ownerProfiles = new Map<string, { email: string | null; displayName: string | null }>();
  for (const uid of ownerUids) {
    const us = await db.doc(`users/${uid}`).get();
    if (us.exists) {
      const d = us.data() ?? {};
      ownerProfiles.set(uid, {
        email: typeof d.email === "string" ? d.email : null,
        displayName: typeof d.displayName === "string" ? d.displayName : null,
      });
    } else {
      ownerProfiles.set(uid, { email: null, displayName: null });
    }
  }

  const academies: AdminDirectoryAcademy[] = [];

  for (const acad of academySnaps) {
    const academyId = acad.id;
    const name = typeof acad.get("name") === "string" ? (acad.get("name") as string) : "";
    const ownerUid = typeof acad.get("ownerUid") === "string" ? (acad.get("ownerUid") as string) : "";
    if (!ownerUid) continue;

    const op = ownerProfiles.get(ownerUid) ?? { email: null, displayName: null };

    const [teachersSnap, parentsSnap] = await Promise.all([
      db.collection(`academies/${academyId}/teachers`).get(),
      db.collection(`academies/${academyId}/parents`).get(),
    ]);

    const teachers: AdminDirectoryMember[] = teachersSnap.docs.map((d) => {
      const data = d.data();
      return {
        docId: d.id,
        authUid: memberAuthUid(data, d.id),
        email: typeof data.email === "string" ? data.email : "",
        displayName: typeof data.displayName === "string" ? data.displayName : "",
        status: typeof data.status === "string" ? data.status : "",
      };
    });

    const parents: AdminDirectoryMember[] = parentsSnap.docs.map((d) => {
      const data = d.data();
      return {
        docId: d.id,
        authUid: memberAuthUid(data, d.id),
        email: typeof data.email === "string" ? data.email : "",
        displayName: typeof data.displayName === "string" ? data.displayName : "",
        status: typeof data.status === "string" ? data.status : "",
      };
    });

    academies.push({
      academyId,
      name,
      ownerUid,
      ownerEmail: op.email,
      ownerDisplayName: op.displayName,
      teachers,
      parents,
    });
  }

  return { ok: true as const, academies };
});

/**
 * 관리자용 — 학원 문서와 하위 teachers/parents/students/secrets 전부 삭제 후
 * 연결된 Auth 사용자(오너·멤버)를 제거합니다. 운영 데이터에 영향을 주므로 신중히 사용하세요.
 */
export const adminDeleteAcademyCascade = onCall(async (request) => {
  assertAdmin(request as unknown as { auth?: { uid: string; token?: Record<string, unknown> } | null });

  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  if (!academyId || academyId.includes("/")) {
    throw new HttpsError("invalid-argument", "학원 ID가 올바르지 않습니다.");
  }

  const db = admin.firestore();
  const academyRef = db.doc(`academies/${academyId}`);
  const academySnap = await academyRef.get();
  if (!academySnap.exists) {
    throw new HttpsError("not-found", "학원을 찾을 수 없습니다.");
  }

  const ownerUid = typeof academySnap.get("ownerUid") === "string" ? academySnap.get("ownerUid") : "";
  if (!ownerUid) {
    throw new HttpsError("failed-precondition", "학원 ownerUid가 없습니다.");
  }

  const teachersSnap = await db.collection(`academies/${academyId}/teachers`).get();
  const parentsSnap = await db.collection(`academies/${academyId}/parents`).get();

  const authUids = new Set<string>();
  authUids.add(ownerUid);
  teachersSnap.docs.forEach((d) => authUids.add(memberAuthUid(d.data(), d.id)));
  parentsSnap.docs.forEach((d) => authUids.add(memberAuthUid(d.data(), d.id)));

  await deleteAcademyFirestoreDocs(db, academyId);

  for (const uid of authUids) {
    await safeDeleteAuthUser(uid, "adminDeleteAcademyCascade");
  }

  const remainingOwned = await db.collection("academies").where("ownerUid", "==", ownerUid).limit(1).get();
  if (remainingOwned.empty && !(await authUserHasAdminClaim(ownerUid))) {
    await deleteUserDocumentAndKnownSubcollections(db, ownerUid);
  }

  logger.info("adminDeleteAcademyCascade done", { academyId, ownerUid });
  return { ok: true as const };
});

/**
 * 관리자용 — 선생님 또는 학부모 멤버 1명과(가능하면) 해당 Auth 계정을 삭제합니다.
 * 학부모인 경우 자녀 학생 문서도 함께 삭제합니다.
 */
export const adminDeleteMemberUser = onCall(async (request) => {
  assertAdmin(request as unknown as { auth?: { uid: string; token?: Record<string, unknown> } | null });

  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const memberDocId =
    typeof request.data?.memberDocId === "string" ? request.data.memberDocId.trim() : "";
  const role = request.data?.role === "parent" ? "parent" : request.data?.role === "teacher" ? "teacher" : "";
  if (!academyId || academyId.includes("/") || !memberDocId || !role) {
    throw new HttpsError("invalid-argument", "academyId, memberDocId, role(teacher|parent)가 필요합니다.");
  }

  const db = admin.firestore();
  const col = role === "teacher" ? "teachers" : "parents";
  const ref = db.doc(`academies/${academyId}/${col}/${memberDocId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "멤버 문서를 찾을 수 없습니다.");
  }

  const data = snap.data() ?? {};
  const authUid = memberAuthUid(data, memberDocId);

  if (role === "teacher") {
    await stripTeacherFromStudents(db, academyId, authUid);
    await ref.delete();
    await safeDeleteAuthUser(authUid, "adminDeleteMemberUser teacher");
    if (!(await authUserHasAdminClaim(authUid))) {
      await deleteUserDocumentAndKnownSubcollections(db, authUid);
    }
  } else {
    const studentsSnap = await db.collection(`academies/${academyId}/students`).get();
    const toDel = studentsSnap.docs.filter((s) => {
      const pid = s.get("parentUserId");
      return pid === memberDocId || pid === authUid;
    });
    for (const chunk of chunkArray(toDel, 400)) {
      const batch = db.batch();
      for (const s of chunk) batch.delete(s.ref);
      await batch.commit();
    }
    await ref.delete();
    await safeDeleteAuthUser(authUid, "adminDeleteMemberUser parent");
    if (!(await authUserHasAdminClaim(authUid))) {
      await deleteUserDocumentAndKnownSubcollections(db, authUid);
    }
  }

  logger.info("adminDeleteMemberUser done", { academyId, memberDocId, role, authUid });
  return { ok: true as const };
});

/**
 * 관리자용 — `users/{uid}/serverMirror/activation` 일괄·단건 백필(기존 계정 미러가 비어 있을 때).
 * - `userId`가 있으면 해당 UID만 재계산합니다.
 * - 없으면 `users` 컬렉션 문서 ID 기준 페이지네이션으로 최대 `limit`(기본 25, 최대 50)건 처리합니다.
 *   다음 배치는 응답의 `lastUserId`를 `startAfterUserId`로 넘겨 반복 호출하세요.
 */
export const adminReconcileActivationMirrors = onCall(async (request) => {
  assertAdmin(request as unknown as { auth?: { uid: string; token?: Record<string, unknown> } | null });

  const db = admin.firestore();
  const userId = typeof request.data?.userId === "string" ? request.data.userId.trim() : "";
  if (userId) {
    if (userId.includes("/")) {
      throw new HttpsError("invalid-argument", "userId가 올바르지 않습니다.");
    }
    await reconcileUserActivationMirror(db, userId, "bootstrap");
    logger.info("adminReconcileActivationMirrors single", { userId });
    return {
      ok: true as const,
      mode: "single" as const,
      processed: 1,
      lastUserId: userId,
      hasMore: false as const,
    };
  }

  const limit = clampInt(request.data?.limit, 25, 1, 50);
  const startAfterUserId =
    typeof request.data?.startAfterUserId === "string" ? request.data.startAfterUserId.trim() : "";
  if (startAfterUserId.includes("/")) {
    throw new HttpsError("invalid-argument", "startAfterUserId가 올바르지 않습니다.");
  }

  let q = db.collection("users").orderBy(FieldPath.documentId()).limit(limit);
  if (startAfterUserId) {
    q = q.startAfter(startAfterUserId);
  }
  const snap = await q.get();
  let last: string | undefined;
  for (const d of snap.docs) {
    await reconcileUserActivationMirror(db, d.id, "bootstrap");
    last = d.id;
  }
  logger.info("adminReconcileActivationMirrors batch", {
    limit,
    startAfterUserId: startAfterUserId || null,
    processed: snap.size,
  });
  return {
    ok: true as const,
    mode: "batch" as const,
    processed: snap.size,
    lastUserId: last ?? null,
    hasMore: snap.size === limit,
  };
});
