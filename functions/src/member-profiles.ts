import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";

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
