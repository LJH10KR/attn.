import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  academySeqMetaPath,
  assertValidAcademyAttnId,
  attnLoginIndexPath,
  formatParentAttnId,
} from "./lib/attn-id";
import { assertKrPhoneRequired } from "./lib/kr-phone";
import {
  assertContactEmail,
  issueEmailVerificationOtpForUid,
} from "./lib/email-verification-otp";
import {
  assertParentLoginIdAvailable,
  normalizeParentLoginId,
  resolveParentGoogleLoginId,
  validateParentLoginIdFormat,
} from "./lib/parent-login-id";

function internalEmailForAttnId(attnId: string): string {
  const safe = attnId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `attn+${safe}@provision.attndot.internal`;
}

async function assertAcademyAcceptsSignup(
  db: admin.firestore.Firestore,
  academyId: string,
): Promise<void> {
  try {
    assertValidAcademyAttnId(academyId);
  } catch {
    throw new HttpsError("invalid-argument", "학원 로그인 번호 형식이 올바르지 않습니다.");
  }
  const academySnap = await db.doc(`academies/${academyId}`).get();
  if (!academySnap.exists) {
    throw new HttpsError("not-found", "학원을 찾을 수 없습니다.");
  }
  if (academySnap.get("status") === "archived") {
    throw new HttpsError("failed-precondition", "이 학원은 현재 가입을 받지 않습니다.");
  }
}

async function allocateParentAttnId(
  db: admin.firestore.Firestore,
  academyId: string,
  normalizedLoginId: string,
): Promise<string> {
  return db.runTransaction(async (tx) => {
    const seqRef = db.doc(academySeqMetaPath(academyId));
    const seqSnap = await tx.get(seqRef);
    const nextParentSeq = (seqSnap.get("nextParentSeq") as number) || 1;
    const newAttnId = formatParentAttnId(academyId, nextParentSeq);
    const loginIndexRef = db.doc(attnLoginIndexPath(normalizedLoginId));
    const loginIndexSnap = await tx.get(loginIndexRef);
    if (loginIndexSnap.exists) {
      throw new HttpsError("already-exists", "이미 사용 중인 로그인 ID입니다.");
    }
    tx.set(seqRef, { nextParentSeq: nextParentSeq + 1 }, { merge: true });
    return newAttnId;
  });
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

/** 공개 — 학부모 로그인 ID 중복 확인 (전역 유일) */
export const checkParentLoginIdAvailable = onCall(async (request) => {
  const raw =
    typeof request.data?.loginId === "string"
      ? request.data.loginId
      : typeof request.data?.loginIdRaw === "string"
        ? request.data.loginIdRaw
        : "";
  if (!raw.trim()) {
    throw new HttpsError("invalid-argument", "로그인 ID를 입력해 주세요.");
  }
  const db = admin.firestore();
  const loginId = await assertParentLoginIdAvailable(db, raw);
  return { available: true, loginId };
});

/** 인증 — Google 가입 직전 상태(이메일·이미 가입 여부) */
export const getParentSignupGoogleStatus = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Google 로그인 후 다시 시도해 주세요.");
  }
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  if (!academyId) {
    throw new HttpsError("invalid-argument", "학원 정보가 올바르지 않습니다.");
  }

  const db = admin.firestore();
  await assertAcademyAcceptsSignup(db, academyId);

  const uid = request.auth.uid;
  const { loginId, displayName } = await resolveParentGoogleLoginId(uid);

  const memberSnap = await db.doc(`academies/${academyId}/parents/${uid}`).get();
  const indexSnap = await db.doc(attnLoginIndexPath(loginId)).get();
  const indexUid =
    indexSnap.exists && typeof indexSnap.get("authUid") === "string"
      ? indexSnap.get("authUid")
      : null;

  return {
    loginId,
    suggestedDisplayName: displayName,
    alreadyMember: memberSnap.exists,
    loginIdTaken: indexSnap.exists && indexUid !== uid,
  };
});

/** 인증 — Google 계정으로 학부모 가입 완료(이름·전화번호 필수) */
export const registerParentGoogleSignup = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Google 로그인 후 다시 시도해 주세요.");
  }
  const uid = request.auth.uid;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const displayNameRaw =
    typeof request.data?.displayName === "string" ? request.data.displayName : "";
  const displayName = displayNameRaw.trim();
  const agreeTerms = request.data?.agreeTerms === true;

  if (!academyId) {
    throw new HttpsError("invalid-argument", "학원 정보가 올바르지 않습니다.");
  }
  if (!displayName) {
    throw new HttpsError("invalid-argument", "이름을 입력해 주세요.");
  }
  if (displayName.length > 60) {
    throw new HttpsError("invalid-argument", "이름은 60자 이하로 입력해 주세요.");
  }
  const phone = assertKrPhoneRequired(request.data?.phone);
  if (!agreeTerms) {
    throw new HttpsError("invalid-argument", "서비스 이용에 동의해 주세요.");
  }

  const db = admin.firestore();
  await assertAcademyAcceptsSignup(db, academyId);

  const existingMember = await db.doc(`academies/${academyId}/parents/${uid}`).get();
  if (existingMember.exists) {
    throw new HttpsError("already-exists", "이미 이 학원에 가입된 계정입니다. 로그인해 주세요.");
  }

  const { loginId } = await resolveParentGoogleLoginId(uid);
  const indexSnap = await db.doc(attnLoginIndexPath(loginId)).get();
  if (indexSnap.exists) {
    const otherUid = indexSnap.get("authUid");
    if (otherUid !== uid) {
      throw new HttpsError(
        "already-exists",
        "이 Google 이메일은 이미 다른 계정에 연결되어 있습니다. 로그인해 주세요.",
      );
    }
  }

  const attnId = await allocateParentAttnId(db, academyId, loginId);
  const memberRef = db.doc(`academies/${academyId}/parents/${uid}`);
  const googleEmail = loginId;

  const batch = db.batch();
  batch.set(memberRef, {
    attnId,
    loginId,
    displayName,
    phone,
    email: googleEmail,
    academyId,
    status: "active",
    authUid: uid,
    authProvider: "google",
    childrenCount: 0,
    nextStudentSeq: 1,
    signupSource: "parent_link_google",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    activatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.doc(`academies/${academyId}/parents/${uid}/secrets/login`), {
    authProvider: "google",
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.doc(attnLoginIndexPath(loginId)), {
    attnId,
    loginId,
    academyId,
    authUid: uid,
    role: "parent",
    authProvider: "google",
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  try {
    await admin.auth().updateUser(uid, { displayName });
  } catch {
    /* optional */
  }

  await admin.auth().setCustomUserClaims(uid, {
    role: "parent",
    academyId,
    membershipStatus: "active",
  });

  return {
    attnId,
    loginId,
    academyId,
    membershipStatus: "active" as const,
  };
});

/** 공개 — 학부모 자가 가입 (비밀번호·이름·로그인 ID 직접 설정 → 즉시 active) */
export const registerParentSelfSignup = onCall(async (request) => {
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const loginIdRaw =
    typeof request.data?.loginId === "string" ? request.data.loginId : "";
  const displayNameRaw =
    typeof request.data?.displayName === "string" ? request.data.displayName : "";
  const displayName = displayNameRaw.trim();
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
  if (!displayName) {
    throw new HttpsError("invalid-argument", "이름을 입력해 주세요.");
  }
  if (displayName.length > 60) {
    throw new HttpsError("invalid-argument", "이름은 60자 이하로 입력해 주세요.");
  }
  const phone = assertKrPhoneRequired(request.data?.phone);
  const contactEmail = assertContactEmail(request.data?.contactEmail);
  if (!password) {
    throw new HttpsError("invalid-argument", "비밀번호를 입력해 주세요.");
  }
  if (password.length < 6) {
    throw new HttpsError("invalid-argument", "비밀번호는 6자 이상이어야 합니다.");
  }
  if (!agreeTerms) {
    throw new HttpsError("invalid-argument", "서비스 이용에 동의해 주세요.");
  }
  if (!loginIdRaw.trim()) {
    throw new HttpsError("invalid-argument", "로그인 ID를 입력해 주세요.");
  }
  validateParentLoginIdFormat(loginIdRaw);
  const normalizedLoginId = normalizeParentLoginId(loginIdRaw);

  const db = admin.firestore();
  await assertAcademyAcceptsSignup(db, academyId);

  const attnId = await allocateParentAttnId(db, academyId, normalizedLoginId);

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
    loginId: normalizedLoginId,
    displayName,
    phone,
    email: "",
    contactEmail,
    contactEmailVerified: false,
    academyId,
    status: "pending_email_verification",
    authUid,
    childrenCount: 0,
    nextStudentSeq: 1,
    authProvider: "password",
    signupSource: "parent_link",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.doc(`academies/${academyId}/parents/${authUid}/secrets/login`), {
    authProvider: "password",
    password,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.doc(attnLoginIndexPath(normalizedLoginId)), {
    attnId,
    loginId: normalizedLoginId,
    academyId,
    authUid,
    role: "parent",
    authProvider: "password",
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  await admin.auth().setCustomUserClaims(authUid, {
    role: "parent",
    academyId,
    membershipStatus: "pending_email_verification",
  });

  try {
    await issueEmailVerificationOtpForUid({
      uid: authUid,
      email: contactEmail,
      displayName,
      purpose: "parent",
    });
  } catch {
    /* 가입은 완료 — 로그인 화면에서 재발송 가능 */
  }

  return {
    attnId,
    loginId: normalizedLoginId,
    academyId,
    membershipStatus: "pending_email_verification" as const,
    contactEmail,
  };
});
