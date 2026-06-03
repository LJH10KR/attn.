import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  academySeqMetaPath,
  assertValidAcademyAttnId,
  attnLoginIndexPath,
  formatParentAttnId,
} from "./lib/attn-id";

function internalEmailForAttnId(attnId: string): string {
  const safe = attnId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `attn+${safe}@provision.attndot.internal`;
}

/** 공개 — 학부모 가입 링크용 학원 정보 */
export const getParentSignupAcademyInfo = onCall(async (request) => {
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  if (!academyId) {
    throw new HttpsError("invalid-argument", "학원 정보가 올바르지 않습니다.");
  }
  try {
    assertValidAcademyAttnId(academyId);
  } catch {
    throw new HttpsError("invalid-argument", "학원 로그인 번호 형식이 올바르지 않습니다.");
  }

  const snap = await admin.firestore().doc(`academies/${academyId}`).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "학원을 찾을 수 없습니다.");
  }
  const status = snap.get("status");
  if (status === "archived") {
    throw new HttpsError("failed-precondition", "이 학원은 현재 가입을 받지 않습니다.");
  }
  const name = snap.get("name");
  return {
    academyId,
    name: typeof name === "string" && name.trim() ? name.trim() : "학원",
  };
});

/** 공개 — 학부모 자가 가입 (비밀번호·이름 직접 설정 → 즉시 active) */
export const registerParentSelfSignup = onCall(async (request) => {
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const displayName =
    typeof request.data?.displayName === "string" ? request.data.displayName.trim() : "";
  const password = typeof request.data?.password === "string" ? request.data.password : "";
  const agreeTerms = request.data?.agreeTerms === true;

  if (!academyId) {
    throw new HttpsError("invalid-argument", "학원 정보가 올바르지 않습니다.");
  }
  try {
    assertValidAcademyAttnId(academyId);
  } catch {
    throw new HttpsError("invalid-argument", "학원 로그인 번호 형식이 올바르지 않습니다.");
  }
  if (!displayName || displayName.length > 60) {
    throw new HttpsError("invalid-argument", "이름을 1~60자로 입력해 주세요.");
  }
  if (password.length < 6) {
    throw new HttpsError("invalid-argument", "비밀번호는 6자 이상이어야 합니다.");
  }
  if (!agreeTerms) {
    throw new HttpsError("invalid-argument", "서비스 이용에 동의해 주세요.");
  }

  const db = admin.firestore();
  const academySnap = await db.doc(`academies/${academyId}`).get();
  if (!academySnap.exists) {
    throw new HttpsError("not-found", "학원을 찾을 수 없습니다.");
  }
  if (academySnap.get("status") === "archived") {
    throw new HttpsError("failed-precondition", "이 학원은 현재 가입을 받지 않습니다.");
  }

  const attnId = await db.runTransaction(async (tx) => {
    const seqRef = db.doc(academySeqMetaPath(academyId));
    const seqSnap = await tx.get(seqRef);
    const nextParentSeq = (seqSnap.get("nextParentSeq") as number) || 1;
    const newAttnId = formatParentAttnId(academyId, nextParentSeq);
    const indexRef = db.doc(attnLoginIndexPath(newAttnId));
    const indexSnap = await tx.get(indexRef);
    if (indexSnap.exists) {
      throw new HttpsError("internal", "가입 번호를 할당하지 못했습니다. 다시 시도해 주세요.");
    }
    tx.set(seqRef, { nextParentSeq: nextParentSeq + 1 }, { merge: true });
    return newAttnId;
  });

  const email = internalEmailForAttnId(attnId);
  let userRecord: admin.auth.UserRecord;
  try {
    userRecord = await admin.auth().createUser({
      email,
      password,
      displayName,
      emailVerified: false,
      disabled: false,
    });
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "이미 가입된 계정입니다. 로그인해 주세요.");
    }
    throw new HttpsError("internal", "계정을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }

  const authUid = userRecord.uid;
  const memberRef = db.doc(`academies/${academyId}/parents/${authUid}`);

  const batch = db.batch();
  batch.set(memberRef, {
    attnId,
    displayName,
    email: "",
    academyId,
    status: "active",
    authUid,
    childrenCount: 0,
    nextStudentSeq: 1,
    signupSource: "parent_link",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    activatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.doc(`academies/${academyId}/parents/${authUid}/secrets/login`), {
    password,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.doc(attnLoginIndexPath(attnId)), {
    attnId,
    academyId,
    authUid,
    role: "parent",
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  await admin.auth().setCustomUserClaims(authUid, {
    role: "parent",
    academyId,
    membershipStatus: "active",
  });

  const customToken = await admin.auth().createCustomToken(authUid, {
    role: "parent",
    academyId,
    membershipStatus: "active",
  });

  return {
    attnId,
    academyId,
    customToken,
    membershipStatus: "active" as const,
  };
});
