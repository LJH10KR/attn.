import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { attnLoginIndexPath, formatStudentAttnId } from "./attn-id";
import { pickTemplateDisplayNameUnique } from "./korean-template-names";
import { allocateTeacherLoginId } from "./teacher-login-id";

export type MemberKind = "teacher" | "parent";

export type MemberStatus = "pending_setup" | "active" | "inactive";

export type ProvisionedMember = {
  authUid: string;
  attnId: string;
  /** 선생님 로그인용 별칭 — attnLoginIndex 키 */
  loginId: string;
  displayName: string;
  tempPassword: string;
  role: MemberKind;
};

export function randomTempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 10; i++) {
    s += chars[crypto.randomInt(0, chars.length)]!;
  }
  return s + "1a!";
}

function internalEmailForAttnId(attnId: string): string {
  const safe = attnId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `attn+${safe}@provision.attndot.internal`;
}

export async function provisionMemberAccount(params: {
  db: admin.firestore.Firestore;
  academyId: string;
  attnId: string;
  role: MemberKind;
  displayName: string;
  tempPassword?: string;
}): Promise<ProvisionedMember> {
  const { db, academyId, attnId, role, displayName } = params;
  const tempPassword = params.tempPassword ?? randomTempPassword();
  const email = internalEmailForAttnId(attnId);

  const loginId =
    role === "teacher" ? await allocateTeacherLoginId(db) : attnId;

  const existingIndex = await db.doc(attnLoginIndexPath(loginId)).get();
  if (existingIndex.exists) {
    throw new Error("LOGIN_ID_EXISTS");
  }

  let userRecord: admin.auth.UserRecord;
  try {
    userRecord = await admin.auth().createUser({
      email,
      password: tempPassword,
      displayName,
      emailVerified: false,
      disabled: false,
    });
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === "auth/email-already-exists") {
      throw new Error("AUTH_EMAIL_COLLISION");
    }
    throw e;
  }

  const authUid = userRecord.uid;
  const col = role === "teacher" ? "teachers" : "parents";
  const memberRef = db.doc(`academies/${academyId}/${col}/${authUid}`);

  const memberData: Record<string, unknown> = {
    attnId,
    displayName,
    email: "",
    academyId,
    status: "pending_setup" satisfies MemberStatus,
    authUid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (role === "teacher") {
    memberData.loginId = loginId;
  }
  if (role === "parent") {
    memberData.childrenCount = 0;
    memberData.nextStudentSeq = 1;
  }

  const batch = db.batch();
  batch.set(memberRef, memberData);
  batch.set(db.doc(`academies/${academyId}/${col}/${authUid}/secrets/login`), {
    tempPassword,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.doc(attnLoginIndexPath(loginId)), {
    loginId,
    attnId,
    academyId,
    authUid,
    role,
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  await admin.auth().setCustomUserClaims(authUid, {
    role,
    academyId,
    membershipStatus: "pending_setup",
  });

  return { authUid, attnId, loginId, displayName, tempPassword, role };
}

export async function provisionTemplateStudentsForParent(params: {
  db: admin.firestore.Firestore;
  academyId: string;
  parentAuthUid: string;
  parentAttnId: string;
  count: number;
  usedNames: Set<string>;
}): Promise<Array<{ studentId: string; attnId: string; name: string }>> {
  const { db, academyId, parentAuthUid, parentAttnId, count, usedNames } = params;
  const parentRef = db.doc(`academies/${academyId}/parents/${parentAuthUid}`);
  const parentSnap = await parentRef.get();
  if (!parentSnap.exists) {
    throw new Error("PARENT_NOT_FOUND");
  }

  const created: Array<{ studentId: string; attnId: string; name: string }> = [];

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(parentRef);
    let nextSeq = (snap.get("nextStudentSeq") as number) || 1;
    const batchWrites: Array<() => void> = [];

    for (let i = 0; i < count; i++) {
      const studentSeq = nextSeq;
      nextSeq += 1;
      const attnId = formatStudentAttnId(parentAttnId, studentSeq);
      const name = pickTemplateDisplayNameUnique(usedNames);
      const studentRef = db.collection(`academies/${academyId}/students`).doc();
      batchWrites.push(() => {
        tx.set(studentRef, {
          attnId,
          parentUserId: parentAuthUid,
          name,
          age: 8,
          phone: "",
          emergencyContact: "",
          assignedTeacherUids: [],
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      created.push({ studentId: studentRef.id, attnId, name });
    }

    for (const w of batchWrites) {
      w();
    }
    tx.update(parentRef, {
      nextStudentSeq: nextSeq,
      childrenCount: FieldValue.increment(count),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return created;
}
