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

/** 쿼리에 걸리는 문서를 400개씩 나눠 끝까지 삭제 */
export async function deleteQueryDocs(
  db: admin.firestore.Firestore,
  query: FirebaseFirestore.Query,
): Promise<number> {
  let total = 0;
  for (;;) {
    const snap = await query.limit(400).get();
    if (snap.empty) return total;
    await batchDeleteRefs(db, snap.docs.map((d) => d.ref));
    total += snap.size;
    if (snap.size < 400) return total;
  }
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
  const col = role === "teacher" ? "staff" : "parents";
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
  const col = role === "teacher" ? "staff" : "parents";
  const m = path.match(new RegExp(`^academies\\/([^/]+)\\/${col}\\/`));
  return m ? m[1] : null;
}

/** Console에서 UID 소유자를 식별할 수 있도록 `users/{uid}`에 요약 프로필 기록 */
export async function syncUserAdminProfile(
  db: admin.firestore.Firestore,
  authUid: string,
): Promise<void> {
  if (!authUid || authUid.startsWith("academy_")) return;

  const [teacherSnaps, parentSnaps] = await Promise.all([
    db.collectionGroup("staff").where("authUid", "==", authUid).limit(10).get(),
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

/**
 * Auth 연동 사용자의 Firestore 프로필·미러·OTP 등 (서브컬렉션 먼저, 문서는 마지막).
 * 2-N: 원장 동의 기록(`legalConsents/{uid}`, ★8)과 이 계정에게 가는 출결 푸시 전달 문서(`_pushDeliveries`, F9)도.
 */
export async function purgeUserFirestoreData(
  db: admin.firestore.Firestore,
  userId: string,
): Promise<void> {
  if (!userId || userId.includes("/") || userId.startsWith("academy_")) return;

  for (const sub of ["pushSubscriptions", "dashboardBellItems", "serverMirror"] as const) {
    await deleteCollectionDocs(db, `users/${userId}/${sub}`);
  }
  await deleteQueryDocs(db, db.collection("_pushDeliveries").where("recipientUid", "==", userId));

  for (const path of [
    `emailVerificationOtps/${userId}`,
    `legalConsents/${userId}`,
    `_accountWithdrawals/${userId}`,
    `users/${userId}`,
  ]) {
    try {
      await db.doc(path).delete();
    } catch {
      /* optional */
    }
  }
}

/** 학생 하위 기록 컬렉션 — 학생·학원 삭제 때 함께 지운다 */
const STUDENT_SUBCOLLECTIONS = ["attendanceRecords", "tuitionInvoices", "sessionLogs"] as const;

/**
 * 학생 문서 + serverSecrets + 하위 기록 + 학원 메모(studentNotes) + 반 출결(`attendance`, 2-I)·정정 이력(3-A) 삭제.
 * 학원 전체 삭제는 반 출결 컬렉션을 따로 한 번에 지우므로 `classAttendance: "skip"`.
 */
export async function deleteStudentDocs(
  db: admin.firestore.Firestore,
  academyId: string,
  studentIds: string[],
  opts: { classAttendance: "per_student" | "skip" } = { classAttendance: "per_student" },
): Promise<void> {
  const refs: DocumentReference[] = [];
  for (const studentId of studentIds) {
    if (opts.classAttendance === "per_student") {
      // 반 출결(2-I)·출결 정정 이력(3-A B6) — 학원 전체 삭제는 recursiveDelete가 함께 지운다
      for (const col of ["attendance", "attendanceCorrections"] as const) {
        const snap = await db
          .collection(`academies/${academyId}/${col}`)
          .where("studentId", "==", studentId)
          .get();
        refs.push(...snap.docs.map((d) => d.ref));
      }
    }
    refs.push(db.doc(`academies/${academyId}/studentNotes/${studentId}`));
    for (const sub of STUDENT_SUBCOLLECTIONS) {
      const subSnap = await db
        .collection(`academies/${academyId}/students/${studentId}/${sub}`)
        .get();
      refs.push(...subSnap.docs.map((d) => d.ref));
    }
    refs.push(db.doc(`academies/${academyId}/students/${studentId}`));
    refs.push(
      db.doc(`academies/${academyId}/students/${studentId}/serverSecrets/checkIn`),
    );
  }
  await batchDeleteRefs(db, refs);
}
