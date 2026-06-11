import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { attnLoginIndexPath } from "./lib/attn-id";
import {
  assertMemberLoginIdAvailable,
  normalizeMemberLoginId,
  validateMemberLoginIdFormat,
} from "./lib/member-login-id";
import { parseOptionalKrPhone } from "./lib/kr-phone";
import { normalizeParentLoginEmail } from "./lib/parent-login-id";

function teacherAcademyIdFromMemberPath(path: string): string | null {
  const m = path.match(/^academies\/([^/]+)\/teachers\//);
  return m ? m[1] : null;
}

async function assertTeacherAuth(request: {
  auth?: { uid: string; token: Record<string, unknown> };
}): Promise<{ uid: string; academyId: string; memberDocId: string }> {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const uid = request.auth.uid;
  const token = request.auth.token;
  const claimAcademyId = typeof token.academyId === "string" ? token.academyId : "";
  if (token.role === "teacher" && claimAcademyId) {
    return { uid, academyId: claimAcademyId, memberDocId: uid };
  }

  const snaps = await admin
    .firestore()
    .collectionGroup("teachers")
    .where("authUid", "==", uid)
    .limit(10)
    .get();
  if (snaps.empty) {
    throw new HttpsError("permission-denied", "선생님 계정만 수정할 수 있습니다.");
  }
  const preferred =
    snaps.docs.find((d) => d.get("status") === "active") ?? snaps.docs[0]!;
  const academyId = teacherAcademyIdFromMemberPath(preferred.ref.path);
  if (!academyId) {
    throw new HttpsError("failed-precondition", "학원 정보가 없습니다.");
  }
  return { uid, academyId, memberDocId: preferred.id };
}

function assertParentAuth(request: {
  auth?: { uid: string; token: Record<string, unknown> };
}): { uid: string; academyId: string } {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const token = request.auth.token;
  if (token.role !== "parent") {
    throw new HttpsError("permission-denied", "학부모 계정만 수정할 수 있습니다.");
  }
  const academyId = typeof token.academyId === "string" ? token.academyId : "";
  if (!academyId) {
    throw new HttpsError("failed-precondition", "학원 정보가 없습니다.");
  }
  return { uid: request.auth.uid, academyId };
}

async function verifyMemberLoginPassword(
  academyId: string,
  uid: string,
  role: "teacher" | "parent",
  password: string,
): Promise<void> {
  const col = role === "teacher" ? "teachers" : "parents";
  const secretSnap = await admin
    .firestore()
    .doc(`academies/${academyId}/${col}/${uid}/secrets/login`)
    .get();
  if (!secretSnap.exists) {
    throw new HttpsError("failed-precondition", "로그인 정보가 설정되지 않았습니다.");
  }
  const stored = secretSnap.get("tempPassword");
  const current = secretSnap.get("password");
  const ok =
    (typeof stored === "string" && stored === password) ||
    (typeof current === "string" && current === password);
  if (!ok) {
    throw new HttpsError("permission-denied", "현재 비밀번호가 올바르지 않습니다.");
  }
}

function assertDisplayName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > 60) {
    throw new HttpsError("invalid-argument", "이름을 1~60자로 입력해 주세요.");
  }
  return name;
}

/** 선생님 — 본인 표시 이름·전화번호 변경 */
export const updateTeacherProfile = onCall(async (request) => {
  const { uid, academyId, memberDocId } = await assertTeacherAuth(request);

  const displayName = assertDisplayName(request.data?.displayName);
  const hasPhoneField = request.data != null && "phone" in request.data;
  const phone = hasPhoneField ? parseOptionalKrPhone(request.data?.phone) : undefined;
  const ref = admin.firestore().doc(`academies/${academyId}/teachers/${memberDocId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "선생님 정보를 찾을 수 없습니다.");
  }

  const patch: Record<string, unknown> = {
    displayName,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (phone !== undefined) {
    patch.phone = phone;
  }
  await ref.update(patch);
  try {
    await admin.auth().updateUser(uid, { displayName });
  } catch {
    /* Auth displayName은 부가 정보 */
  }

  const membershipStatus =
    typeof snap.get("status") === "string" ? snap.get("status") : "pending_setup";
  await admin.auth().setCustomUserClaims(uid, {
    role: "teacher",
    academyId,
    membershipStatus,
  });

  return {
    ok: true,
    displayName,
    ...(phone !== undefined ? { phone } : {}),
  };
});

/** 학부모 — 본인 표시 이름 변경 */
export const updateParentProfile = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const uid = request.auth.uid;
  const token = request.auth.token;
  if (token.role !== "parent") {
    throw new HttpsError("permission-denied", "학부모 계정만 수정할 수 있습니다.");
  }
  const academyId = typeof token.academyId === "string" ? token.academyId : "";
  if (!academyId) {
    throw new HttpsError("failed-precondition", "학원 정보가 없습니다.");
  }

  const displayName = assertDisplayName(request.data?.displayName);
  const ref = admin.firestore().doc(`academies/${academyId}/parents/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "학부모 정보를 찾을 수 없습니다.");
  }

  await ref.update({
    displayName,
    updatedAt: FieldValue.serverTimestamp(),
  });
  try {
    await admin.auth().updateUser(uid, { displayName });
  } catch {
    /* optional */
  }

  return { ok: true, displayName };
});

function googleEmailFromUser(user: admin.auth.UserRecord): string {
  const p = user.providerData.find((x) => x.providerId === "google.com");
  const email = typeof p?.email === "string" ? p.email.trim() : "";
  if (!email) {
    throw new HttpsError(
      "failed-precondition",
      "Google 계정 이메일을 확인할 수 없습니다.",
    );
  }
  return normalizeParentLoginEmail(email);
}

/** 학부모 — Firebase Auth에 Google 연동 후 Firestore 동기화 */
export const syncParentGoogleLink = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const uid = request.auth.uid;
  const token = request.auth.token;
  if (token.role !== "parent") {
    throw new HttpsError("permission-denied", "학부모 계정만 연동할 수 있습니다.");
  }
  const academyId = typeof token.academyId === "string" ? token.academyId : "";
  if (!academyId) {
    throw new HttpsError("failed-precondition", "학원 정보가 없습니다.");
  }

  const user = await admin.auth().getUser(uid);
  const hasGoogle = user.providerData.some((p) => p.providerId === "google.com");
  if (!hasGoogle) {
    throw new HttpsError(
      "failed-precondition",
      "Google 계정 연결 후 다시 시도해 주세요.",
    );
  }
  const googleEmail = googleEmailFromUser(user);

  const memberRef = admin.firestore().doc(`academies/${academyId}/parents/${uid}`);
  const snap = await memberRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "학부모 정보를 찾을 수 없습니다.");
  }

  const authProvider = snap.get("authProvider");
  const patch: Record<string, unknown> = {
    googleLinked: true,
    googleEmail,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (authProvider === "google") {
    patch.email = googleEmail;
  }

  await memberRef.update(patch);
  await admin
    .firestore()
    .doc(`academies/${academyId}/parents/${uid}/secrets/login`)
    .set({ googleLinked: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  return { ok: true, googleEmail };
});

/** 선생님 — Firebase Auth에 Google 연동 후 Firestore 동기화 */
export const syncTeacherGoogleLink = onCall(async (request) => {
  const { uid, academyId, memberDocId } = await assertTeacherAuth(request);

  const user = await admin.auth().getUser(uid);
  const hasGoogle = user.providerData.some((p) => p.providerId === "google.com");
  if (!hasGoogle) {
    throw new HttpsError(
      "failed-precondition",
      "Google 계정 연결 후 다시 시도해 주세요.",
    );
  }
  const googleEmail = googleEmailFromUser(user);

  const memberRef = admin
    .firestore()
    .doc(`academies/${academyId}/teachers/${memberDocId}`);
  const snap = await memberRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "선생님 정보를 찾을 수 없습니다.");
  }

  await memberRef.update({
    googleLinked: true,
    googleEmail,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await admin
    .firestore()
    .doc(`academies/${academyId}/teachers/${memberDocId}/secrets/login`)
    .set({ googleLinked: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  return { ok: true, googleEmail };
});

/** 공개 — 선생님 로그인 ID(별칭) 변경 가능 여부 */
export const checkTeacherLoginIdAvailable = onCall(async (request) => {
  const { uid, academyId, memberDocId } = await assertTeacherAuth(request);
  const raw =
    typeof request.data?.loginId === "string" ? request.data.loginId.trim() : "";
  if (!raw) {
    throw new HttpsError("invalid-argument", "로그인 ID를 입력해 주세요.");
  }
  try {
    validateMemberLoginIdFormat(raw);
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError("invalid-argument", "로그인 ID 형식이 올바르지 않습니다.");
  }

  const memberSnap = await admin
    .firestore()
    .doc(`academies/${academyId}/teachers/${memberDocId}`)
    .get();
  const currentLoginId =
    typeof memberSnap.get("loginId") === "string" ? memberSnap.get("loginId") : "";
  const normalized = normalizeMemberLoginId(raw);
  if (normalized === currentLoginId) {
    return { available: true, loginId: normalized, sameAsCurrent: true };
  }

  const indexSnap = await admin.firestore().doc(attnLoginIndexPath(normalized)).get();
  if (indexSnap.exists && indexSnap.get("authUid") !== uid) {
    throw new HttpsError("already-exists", "이미 사용 중인 로그인 ID입니다.");
  }
  return { available: true, loginId: normalized };
});

/** 선생님 — 로그인 ID(별칭) 변경 — attnId(관리 번호)는 유지 */
export const updateTeacherLoginId = onCall(async (request) => {
  const { uid, academyId, memberDocId } = await assertTeacherAuth(request);
  const newLoginIdRaw =
    typeof request.data?.loginId === "string" ? request.data.loginId.trim() : "";
  const currentPassword =
    typeof request.data?.currentPassword === "string"
      ? request.data.currentPassword
      : "";
  if (!newLoginIdRaw) {
    throw new HttpsError("invalid-argument", "새 로그인 ID를 입력해 주세요.");
  }
  if (!currentPassword) {
    throw new HttpsError("invalid-argument", "현재 비밀번호를 입력해 주세요.");
  }

  await verifyMemberLoginPassword(academyId, uid, "teacher", currentPassword);

  const db = admin.firestore();
  const memberRef = db.doc(`academies/${academyId}/teachers/${memberDocId}`);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) {
    throw new HttpsError("not-found", "선생님 정보를 찾을 수 없습니다.");
  }
  const oldLoginId =
    typeof memberSnap.get("loginId") === "string" ? memberSnap.get("loginId") : "";

  const newLoginId = await assertMemberLoginIdAvailable(db, newLoginIdRaw, uid);
  if (newLoginId === oldLoginId) {
    return { ok: true, loginId: newLoginId };
  }

  const newIndexRef = db.doc(attnLoginIndexPath(newLoginId));

  await db.runTransaction(async (tx) => {
    const freshMember = await tx.get(memberRef);
    const prevLoginId =
      typeof freshMember.get("loginId") === "string" ? freshMember.get("loginId") : "";
    const memberAttnId =
      typeof freshMember.get("attnId") === "string" ? freshMember.get("attnId") : "";
    if (newLoginId === prevLoginId) {
      return;
    }
    const newIndexSnap = await tx.get(newIndexRef);
    if (newIndexSnap.exists && newIndexSnap.get("authUid") !== uid) {
      throw new HttpsError("already-exists", "이미 사용 중인 로그인 ID입니다.");
    }
    const prevIndexKey = prevLoginId || memberAttnId;
    if (prevIndexKey && prevIndexKey !== newLoginId) {
      const oldIndexRef = db.doc(attnLoginIndexPath(prevIndexKey));
      const oldIndexSnap = await tx.get(oldIndexRef);
      if (oldIndexSnap.exists && oldIndexSnap.get("authUid") === uid) {
        tx.delete(oldIndexRef);
      }
    }
    tx.set(newIndexRef, {
      loginId: newLoginId,
      attnId: memberAttnId,
      academyId,
      authUid: uid,
      role: "teacher",
      updatedAt: FieldValue.serverTimestamp(),
      ...(newIndexSnap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    });
    tx.update(memberRef, {
      loginId: newLoginId,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { ok: true, loginId: newLoginId };
});

/** 선생님 — 비밀번호 변경 */
export const updateTeacherPassword = onCall(async (request) => {
  const { uid, academyId, memberDocId } = await assertTeacherAuth(request);
  const currentPassword =
    typeof request.data?.currentPassword === "string"
      ? request.data.currentPassword
      : "";
  const newPassword =
    typeof request.data?.newPassword === "string" ? request.data.newPassword : "";
  if (!currentPassword) {
    throw new HttpsError("invalid-argument", "현재 비밀번호를 입력해 주세요.");
  }
  if (newPassword.length < 6) {
    throw new HttpsError("invalid-argument", "새 비밀번호는 6자 이상이어야 합니다.");
  }
  if (currentPassword === newPassword) {
    throw new HttpsError(
      "invalid-argument",
      "새 비밀번호는 현재 비밀번호와 달라야 합니다.",
    );
  }

  await verifyMemberLoginPassword(academyId, uid, "teacher", currentPassword);

  await admin.auth().updateUser(uid, { password: newPassword });
  await admin
    .firestore()
    .doc(`academies/${academyId}/teachers/${memberDocId}/secrets/login`)
    .set(
      {
        password: newPassword,
        tempPassword: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  return { ok: true };
});

/** 학부모 — 비밀번호 변경 */
export const updateParentPassword = onCall(async (request) => {
  const { uid, academyId } = assertParentAuth(request);
  const currentPassword =
    typeof request.data?.currentPassword === "string"
      ? request.data.currentPassword
      : "";
  const newPassword =
    typeof request.data?.newPassword === "string" ? request.data.newPassword : "";
  if (!currentPassword) {
    throw new HttpsError("invalid-argument", "현재 비밀번호를 입력해 주세요.");
  }
  if (newPassword.length < 6) {
    throw new HttpsError("invalid-argument", "새 비밀번호는 6자 이상이어야 합니다.");
  }
  if (currentPassword === newPassword) {
    throw new HttpsError(
      "invalid-argument",
      "새 비밀번호는 현재 비밀번호와 달라야 합니다.",
    );
  }

  const memberRef = admin.firestore().doc(`academies/${academyId}/parents/${uid}`);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) {
    throw new HttpsError("not-found", "학부모 정보를 찾을 수 없습니다.");
  }
  if (memberSnap.get("authProvider") === "google") {
    throw new HttpsError(
      "failed-precondition",
      "Google 전용 계정은 비밀번호를 변경할 수 없습니다.",
    );
  }

  await verifyMemberLoginPassword(academyId, uid, "parent", currentPassword);

  await admin.auth().updateUser(uid, { password: newPassword });
  await admin.firestore().doc(`academies/${academyId}/parents/${uid}/secrets/login`).set(
    {
      password: newPassword,
      tempPassword: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { ok: true };
});
