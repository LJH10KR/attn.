import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { normalizeParentLoginEmail } from "./lib/parent-login-id";

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
