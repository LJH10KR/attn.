import * as admin from "firebase-admin";
import type { DocumentReference } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { attnLoginIndexPath } from "./attn-id";
import { normalizeParentLoginEmail } from "./parent-login-id";

export function chunkArray<T>(arr: T[], chunkSize: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize) out.push(arr.slice(i, i + chunkSize));
  return out;
}

export async function batchDeleteRefs(
  db: admin.firestore.Firestore,
  refs: DocumentReference[],
): Promise<void> {
  for (const c of chunkArray(refs, 400)) {
    const batch = db.batch();
    for (const ref of c) batch.delete(ref);
    await batch.commit();
  }
}

export async function deleteCollectionDocs(
  db: admin.firestore.Firestore,
  collectionPath: string,
): Promise<void> {
  const snap = await db.collection(collectionPath).get();
  await batchDeleteRefs(
    db,
    snap.docs.map((d) => d.ref),
  );
}

export function loginIndexKeysFromMember(data: FirebaseFirestore.DocumentData): string[] {
  const keys = new Set<string>();
  const loginId = data.loginId;
  const attnId = data.attnId;
  if (typeof loginId === "string" && loginId.trim()) {
    keys.add(loginId.trim());
    if (loginId.includes("@")) {
      keys.add(normalizeParentLoginEmail(loginId));
    }
  }
  if (typeof attnId === "string" && attnId.trim()) {
    keys.add(attnId.trim());
  }
  return [...keys];
}

export async function deleteAttnLoginIndexForMember(
  db: admin.firestore.Firestore,
  data: FirebaseFirestore.DocumentData,
  authUid: string,
): Promise<void> {
  for (const key of loginIndexKeysFromMember(data)) {
    const ref = db.doc(attnLoginIndexPath(key));
    const snap = await ref.get();
    if (snap.exists && snap.get("authUid") === authUid) {
      await ref.delete();
    }
  }
}

export async function deleteMemberLoginSecrets(
  db: admin.firestore.Firestore,
  academyId: string,
  role: "teacher" | "parent",
  memberDocId: string,
): Promise<void> {
  const col = role === "teacher" ? "teachers" : "parents";
  await deleteCollectionDocs(db, `academies/${academyId}/${col}/${memberDocId}/secrets`);
}

export async function deleteStudentServerSecrets(
  db: admin.firestore.Firestore,
  academyId: string,
  studentId: string,
): Promise<void> {
  const ref = db.doc(
    `academies/${academyId}/students/${studentId}/serverSecrets/checkIn`,
  );
  try {
    await ref.delete();
  } catch {
    /* optional */
  }
}

type UserMembershipSummary = {
  role: "teacher" | "parent";
  academyId: string;
  status: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  loginId: string | null;
};

function academyIdFromMemberPath(path: string, role: "teacher" | "parent"): string | null {
  const m = path.match(new RegExp(`^academies\\/([^/]+)\\/${role}s\\/`));
  return m ? m[1] : null;
}

/** Console에서 UID 소유자를 식별할 수 있도록 `users/{uid}`에 요약 프로필 기록 */
export async function syncUserAdminProfile(
  db: admin.firestore.Firestore,
  authUid: string,
): Promise<void> {
  if (!authUid || authUid.startsWith("academy_")) return;

  const [teacherSnaps, parentSnaps] = await Promise.all([
    db.collectionGroup("teachers").where("authUid", "==", authUid).limit(10).get(),
    db.collectionGroup("parents").where("authUid", "==", authUid).limit(10).get(),
  ]);
  if (teacherSnaps.empty && parentSnaps.empty) return;

  const memberships: UserMembershipSummary[] = [];
  for (const d of teacherSnaps.docs) {
    const academyId = academyIdFromMemberPath(d.ref.path, "teacher");
    if (!academyId) continue;
    memberships.push({
      role: "teacher",
      academyId,
      status: typeof d.get("status") === "string" ? d.get("status") : "",
      displayName: typeof d.get("displayName") === "string" ? d.get("displayName") : "",
      phone: typeof d.get("phone") === "string" ? d.get("phone") : null,
      email: typeof d.get("email") === "string" ? d.get("email") : null,
      loginId: typeof d.get("loginId") === "string" ? d.get("loginId") : null,
    });
  }
  for (const d of parentSnaps.docs) {
    const academyId = academyIdFromMemberPath(d.ref.path, "parent");
    if (!academyId) continue;
    memberships.push({
      role: "parent",
      academyId,
      status: typeof d.get("status") === "string" ? d.get("status") : "",
      displayName: typeof d.get("displayName") === "string" ? d.get("displayName") : "",
      phone: typeof d.get("phone") === "string" ? d.get("phone") : null,
      email: typeof d.get("email") === "string" ? d.get("email") : null,
      loginId: typeof d.get("loginId") === "string" ? d.get("loginId") : null,
    });
  }
  if (memberships.length === 0) return;

  const primary =
    memberships.find((m) => m.status === "active") ??
    memberships.find((m) => m.status === "inactive") ??
    memberships[0]!;

  await db.doc(`users/${authUid}`).set(
    {
      displayName: primary.displayName,
      phone: primary.phone,
      email: primary.email,
      loginId: primary.loginId,
      primaryRole: primary.role,
      primaryAcademyId: primary.academyId,
      memberships,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/** Auth 연동 사용자의 Firestore 프로필·미러·OTP 등 (서브컬렉션 먼저, 문서는 마지막) */
export async function purgeUserFirestoreData(
  db: admin.firestore.Firestore,
  userId: string,
): Promise<void> {
  if (!userId || userId.startsWith("academy_")) return;

  for (const sub of ["pushSubscriptions", "dashboardBellItems", "serverMirror"] as const) {
    await deleteCollectionDocs(db, `users/${userId}/${sub}`);
  }

  try {
    await db.doc(`emailVerificationOtps/${userId}`).delete();
  } catch {
    /* optional */
  }
  try {
    await db.doc(`users/${userId}`).delete();
  } catch {
    /* optional */
  }
}

export type AcademyMemberSnapshot = {
  docId: string;
  authUid: string;
  data: FirebaseFirestore.DocumentData;
};

/**
 * 학원 단위 Firestore 데이터 전부 삭제(고아 서브컬렉션·인덱스 포함).
 * Auth 삭제는 호출 측에서 별도 수행합니다.
 */
export async function deleteAcademyFirestoreCascade(
  db: admin.firestore.Firestore,
  academyId: string,
  members?: {
    teachers: AcademyMemberSnapshot[];
    parents: AcademyMemberSnapshot[];
  },
): Promise<{ teacherSnapshots: AcademyMemberSnapshot[]; parentSnapshots: AcademyMemberSnapshot[] }> {
  const teachersSnap = members
    ? null
    : await db.collection(`academies/${academyId}/teachers`).get();
  const parentsSnap = members
    ? null
    : await db.collection(`academies/${academyId}/parents`).get();
  const studentsSnap = await db.collection(`academies/${academyId}/students`).get();

  const teacherSnapshots: AcademyMemberSnapshot[] =
    members?.teachers ??
    teachersSnap!.docs.map((d) => ({
      docId: d.id,
      authUid:
        typeof d.get("authUid") === "string" && d.get("authUid")
          ? (d.get("authUid") as string)
          : d.id,
      data: d.data(),
    }));

  const parentSnapshots: AcademyMemberSnapshot[] =
    members?.parents ??
    parentsSnap!.docs.map((d) => ({
      docId: d.id,
      authUid:
        typeof d.get("authUid") === "string" && d.get("authUid")
          ? (d.get("authUid") as string)
          : d.id,
      data: d.data(),
    }));

  const deleteOps: DocumentReference[] = [];

  for (const t of teacherSnapshots) {
    deleteOps.push(db.doc(`academies/${academyId}/teachers/${t.docId}`));
    deleteOps.push(
      db.doc(`academies/${academyId}/teachers/${t.docId}/secrets/login`),
    );
  }
  for (const p of parentSnapshots) {
    deleteOps.push(db.doc(`academies/${academyId}/parents/${p.docId}`));
    deleteOps.push(
      db.doc(`academies/${academyId}/parents/${p.docId}/secrets/login`),
    );
  }
  for (const s of studentsSnap.docs) {
    deleteOps.push(s.ref);
    deleteOps.push(
      db.doc(`academies/${academyId}/students/${s.id}/serverSecrets/checkIn`),
    );
  }

  const metaSnap = await db.collection(`academies/${academyId}/meta`).get();
  metaSnap.docs.forEach((d) => deleteOps.push(d.ref));

  const inboxSnap = await db.collection(`academies/${academyId}/adminInbox`).get();
  inboxSnap.docs.forEach((d) => deleteOps.push(d.ref));

  const secretsLoginRef = db.doc(`academies/${academyId}/secrets/login`);
  const secretsSnap = await secretsLoginRef.get();
  if (secretsSnap.exists) deleteOps.push(secretsLoginRef);

  deleteOps.push(db.doc(`academies/${academyId}`));

  await batchDeleteRefs(db, deleteOps);

  for (const m of [...teacherSnapshots, ...parentSnapshots]) {
    await deleteAttnLoginIndexForMember(db, m.data, m.authUid);
  }

  return { teacherSnapshots, parentSnapshots };
}

export async function stripTeacherFromStudents(
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

/** 학생 문서 + serverSecrets 삭제 */
export async function deleteStudentDocs(
  db: admin.firestore.Firestore,
  academyId: string,
  studentIds: string[],
): Promise<void> {
  const refs: DocumentReference[] = [];
  for (const studentId of studentIds) {
    refs.push(db.doc(`academies/${academyId}/students/${studentId}`));
    refs.push(
      db.doc(`academies/${academyId}/students/${studentId}/serverSecrets/checkIn`),
    );
  }
  await batchDeleteRefs(db, refs);
}
