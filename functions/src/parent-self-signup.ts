import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { academySeqMetaPath, attnLoginIndexPath, formatParentAttnId } from "./lib/attn-id";
import { SIGNUP_APP_CHECK_OPTIONS } from "./lib/app-check";
import { consumeSignupQuota, resolveSignupLink } from "./lib/signup-links";
import { assertKrPhoneRequired } from "./lib/kr-phone";
import { randomAuthPassword } from "./lib/member-credentials";
import { passwordSecretFields } from "./lib/password-hash";
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

/**
 * 학부모 가입(2-K) — 모든 함수가 가입 QR 토큰(`token`)을 받아 서버가 학원을 찾는다(학원 ID를 받지 않음).
 * App Check 강제(플래그)는 로그인 ID 확인·가입 2개만 — 학원 정보·Google 상태 조회는 토큰으로만 막는다.
 */

/** 공개 — 가입 QR 토큰으로 학원 정보(가입 폼을 보여 주기 전) */
export const getParentSignupAcademyInfo = onCall(async (request) => {
  const link = await resolveSignupLink(admin.firestore(), request.data?.token, "parent");
  return { name: link.academyName };
});

/** 공개 — 학부모 로그인 ID 중복 확인(전역 유일) — 유효한 가입 링크가 있을 때만(무작위 조회 방지) */
export const checkParentLoginIdAvailable = onCall(SIGNUP_APP_CHECK_OPTIONS, async (request) => {
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
  await resolveSignupLink(db, request.data?.token, "parent");
  const loginId = await assertParentLoginIdAvailable(db, raw);
  return { available: true, loginId };
});

/** 인증 — Google 가입 직전 상태(이메일·이미 가입 여부) */
export const getParentSignupGoogleStatus = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Google 로그인 후 다시 시도해 주세요.");
  }
  const db = admin.firestore();
  const { academyId } = await resolveSignupLink(db, request.data?.token, "parent");

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

/**
 * 인증 — Google 계정으로 학부모 가입 완료(이름·전화번호 필수) → 승인 대기(`pending_approval`).
 * 번호 중복은 막지 않고 응답에 번호·원생 정보를 담지 않는다(번호 색인은 학원이 연결할 때 잡음).
 */
export const registerParentGoogleSignup = onCall(SIGNUP_APP_CHECK_OPTIONS, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Google 로그인 후 다시 시도해 주세요.");
  }
  const uid = request.auth.uid;
  const displayNameRaw =
    typeof request.data?.displayName === "string" ? request.data.displayName : "";
  const displayName = displayNameRaw.trim();
  const agreeTerms = request.data?.agreeTerms === true;

  const db = admin.firestore();
  const { academyId } = await resolveSignupLink(db, request.data?.token, "parent");
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

  // 입력·중복 검사를 모두 통과한 뒤 계정을 만들기 직전에 한 건을 센다(링크별 시간당 한도)
  await consumeSignupQuota(db, request.data?.token, "parent");

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
    status: "pending_approval",
    authUid: uid,
    authProvider: "google",
    signupSource: "parent_link_google",
    linkedStudentIds: [],
    approvedAt: null,
    approvedByUid: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
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
    membershipStatus: "pending_approval",
  });

  return {
    attnId,
    loginId,
    academyId,
    membershipStatus: "pending_approval" as const,
  };
});

/**
 * 공개 — 학부모 자가 가입(비밀번호·이름·로그인 ID 직접 설정) → 이메일 인증(OTP) 후 승인 대기.
 * 번호 중복은 막지 않고 응답에 번호·원생 정보를 담지 않는다(인증 없는 함수로 번호 소속을 알아내거나 선점하지 못하게).
 */
export const registerParentSelfSignup = onCall(SIGNUP_APP_CHECK_OPTIONS, async (request) => {
  const loginIdRaw =
    typeof request.data?.loginId === "string" ? request.data.loginId : "";
  const displayNameRaw =
    typeof request.data?.displayName === "string" ? request.data.displayName : "";
  const displayName = displayNameRaw.trim();
  const password = typeof request.data?.password === "string" ? request.data.password : "";
  const agreeTerms = request.data?.agreeTerms === true;

  const db = admin.firestore();
  await resolveSignupLink(db, request.data?.token, "parent");
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
  await assertParentLoginIdAvailable(db, normalizedLoginId);

  // 입력 검사를 모두 통과한 뒤 계정을 만들기 직전에 한 건을 센다(링크별 시간당 한도)
  const { academyId } = await consumeSignupQuota(db, request.data?.token, "parent");

  const attnId = await allocateParentAttnId(db, academyId, normalizedLoginId);

  const email = internalEmailForAttnId(attnId);
  let userRecord: admin.auth.UserRecord;
  try {
    userRecord = await admin.auth().createUser({
      email,
      password: randomAuthPassword(),
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
    authProvider: "password",
    linkedStudentIds: [],
    approvedAt: null,
    approvedByUid: null,
    signupSource: "parent_link",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(
    db.doc(`academies/${academyId}/parents/${authUid}/secrets/login`),
    { authProvider: "password", ...(await passwordSecretFields(password)) },
    { merge: true },
  );
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
