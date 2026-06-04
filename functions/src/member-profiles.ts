import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  assertValidTeacherAttnId,
  attnLoginIndexPath,
} from "./lib/attn-id";
import { normalizeParentLoginEmail } from "./lib/parent-login-id";

const PROVISION_EMAIL_DOMAIN = "@provision.attndot.internal";

function internalEmailForAttnId(attnId: string): string {
  const safe = attnId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `attn+${safe}${PROVISION_EMAIL_DOMAIN}`;
}

function assertTeacherAuth(request: {
  auth?: { uid: string; token: Record<string, unknown> };
}): { uid: string; academyId: string } {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const token = request.auth.token;
  if (token.role !== "teacher") {
    throw new HttpsError("permission-denied", "선생님 계정만 수정할 수 있습니다.");
  }
  const academyId = typeof token.academyId === "string" ? token.academyId : "";
  if (!academyId) {
    throw new HttpsError("failed-precondition", "학원 정보가 없습니다.");
  }
  return { uid: request.auth.uid, academyId };
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

/** 선생님 — 본인 표시 이름 변경 */
export const updateTeacherProfile = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const uid = request.auth.uid;
  const token = request.auth.token;
  if (token.role !== "teacher") {
    throw new HttpsError("permission-denied", "선생님 계정만 수정할 수 있습니다.");
  }
  const academyId = typeof token.academyId === "string" ? token.academyId : "";
  if (!academyId) {
    throw new HttpsError("failed-precondition", "학원 정보가 없습니다.");
  }

  const displayName = assertDisplayName(request.data?.displayName);
  const ref = admin.firestore().doc(`academies/${academyId}/teachers/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "선생님 정보를 찾을 수 없습니다.");
  }

  await ref.update({
    displayName,
    updatedAt: FieldValue.serverTimestamp(),
  });
  try {
    await admin.auth().updateUser(uid, { displayName });
  } catch {
    /* Auth displayName은 부가 정보 */
  }

  return { ok: true, displayName };
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
  const { uid, academyId } = assertTeacherAuth(request);

  const user = await admin.auth().getUser(uid);
  const hasGoogle = user.providerData.some((p) => p.providerId === "google.com");
  if (!hasGoogle) {
    throw new HttpsError(
      "failed-precondition",
      "Google 계정 연결 후 다시 시도해 주세요.",
    );
  }
  const googleEmail = googleEmailFromUser(user);

  const memberRef = admin.firestore().doc(`academies/${academyId}/teachers/${uid}`);
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
    .doc(`academies/${academyId}/teachers/${uid}/secrets/login`)
    .set({ googleLinked: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  return { ok: true, googleEmail };
});

/** 공개 — 선생님 로그인 번호(attnId) 변경 가능 여부 */
export const checkTeacherAttnIdAvailable = onCall(async (request) => {
  const { uid, academyId } = assertTeacherAuth(request);
  const raw =
    typeof request.data?.attnId === "string" ? request.data.attnId.trim() : "";
  if (!raw) {
    throw new HttpsError("invalid-argument", "로그인 번호를 입력해 주세요.");
  }
  try {
    assertValidTeacherAttnId(raw);
  } catch {
    throw new HttpsError(
      "invalid-argument",
      "로그인 번호 형식이 올바르지 않습니다. (예: 00001_01_001)",
    );
  }
  if (!raw.startsWith(`${academyId}_`)) {
    throw new HttpsError(
      "invalid-argument",
      "이 학원에 속한 로그인 번호만 사용할 수 있습니다.",
    );
  }

  const memberSnap = await admin
    .firestore()
    .doc(`academies/${academyId}/teachers/${uid}`)
    .get();
  const current =
    typeof memberSnap.get("attnId") === "string" ? memberSnap.get("attnId") : "";
  if (raw === current) {
    return { available: true, attnId: raw, sameAsCurrent: true };
  }

  const indexSnap = await admin.firestore().doc(attnLoginIndexPath(raw)).get();
  if (indexSnap.exists && indexSnap.get("authUid") !== uid) {
    throw new HttpsError("already-exists", "이미 사용 중인 로그인 번호입니다.");
  }
  return { available: true, attnId: raw };
});

/** 선생님 — 로그인 번호(attnId) 변경 */
export const updateTeacherAttnId = onCall(async (request) => {
  const { uid, academyId } = assertTeacherAuth(request);
  const newAttnId =
    typeof request.data?.attnId === "string" ? request.data.attnId.trim() : "";
  const currentPassword =
    typeof request.data?.currentPassword === "string"
      ? request.data.currentPassword
      : "";
  if (!newAttnId) {
    throw new HttpsError("invalid-argument", "새 로그인 번호를 입력해 주세요.");
  }
  if (!currentPassword) {
    throw new HttpsError("invalid-argument", "현재 비밀번호를 입력해 주세요.");
  }

  try {
    assertValidTeacherAttnId(newAttnId);
  } catch {
    throw new HttpsError(
      "invalid-argument",
      "로그인 번호 형식이 올바르지 않습니다. (예: 00001_01_001)",
    );
  }
  if (!newAttnId.startsWith(`${academyId}_`)) {
    throw new HttpsError(
      "invalid-argument",
      "이 학원에 속한 로그인 번호만 사용할 수 있습니다.",
    );
  }

  await verifyMemberLoginPassword(academyId, uid, "teacher", currentPassword);

  const db = admin.firestore();
  const memberRef = db.doc(`academies/${academyId}/teachers/${uid}`);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) {
    throw new HttpsError("not-found", "선생님 정보를 찾을 수 없습니다.");
  }
  const oldAttnId =
    typeof memberSnap.get("attnId") === "string" ? memberSnap.get("attnId") : "";
  if (newAttnId === oldAttnId) {
    return { ok: true, attnId: newAttnId };
  }

  const newIndexRef = db.doc(attnLoginIndexPath(newAttnId));
  await db.runTransaction(async (tx) => {
    const freshMember = await tx.get(memberRef);
    const oldId =
      typeof freshMember.get("attnId") === "string" ? freshMember.get("attnId") : "";
    if (newAttnId === oldId) {
      return;
    }
    const newIndexSnap = await tx.get(newIndexRef);
    if (newIndexSnap.exists && newIndexSnap.get("authUid") !== uid) {
      throw new HttpsError("already-exists", "이미 사용 중인 로그인 번호입니다.");
    }
    if (oldId) {
      const oldIndexRef = db.doc(attnLoginIndexPath(oldId));
      const oldIndexSnap = await tx.get(oldIndexRef);
      if (oldIndexSnap.exists && oldIndexSnap.get("authUid") === uid) {
        tx.delete(oldIndexRef);
      }
    }
    tx.set(newIndexRef, {
      attnId: newAttnId,
      academyId,
      authUid: uid,
      role: "teacher",
      updatedAt: FieldValue.serverTimestamp(),
      ...(newIndexSnap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    });
    tx.update(memberRef, {
      attnId: newAttnId,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  try {
    const user = await admin.auth().getUser(uid);
    const email = user.email ?? "";
    if (email.includes(PROVISION_EMAIL_DOMAIN)) {
      await admin.auth().updateUser(uid, { email: internalEmailForAttnId(newAttnId) });
    }
  } catch {
    /* optional */
  }

  return { ok: true, attnId: newAttnId };
});

/** 선생님 — 비밀번호 변경 */
export const updateTeacherPassword = onCall(async (request) => {
  const { uid, academyId } = assertTeacherAuth(request);
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
  await admin.firestore().doc(`academies/${academyId}/teachers/${uid}/secrets/login`).set(
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
