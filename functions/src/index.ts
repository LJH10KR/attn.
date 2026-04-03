import {setGlobalOptions} from "firebase-functions";
import {onCall, HttpsError} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

if (!admin.apps.length) {
  admin.initializeApp();
}

setGlobalOptions({maxInstances: 10, region: "asia-northeast3"});

/** 신규 학원 등록용 — 소문자·슬러그 형식 */
function normalizeNewAcademyId(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/**
 * 기존 문서 경로용 — Firestore 문서 ID는 대소문자를 구분하므로 소문자 강제 없음.
 * (예전 addDoc 자동 ID·혼합 대소문자 ID와 호환)
 */
function requireAcademyDocumentId(raw: unknown): string {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    throw new HttpsError("invalid-argument", "학원 ID를 입력해 주세요.");
  }
  if (id.includes("/")) {
    throw new HttpsError("invalid-argument", "유효하지 않은 학원 ID입니다.");
  }
  if (id.length > 800) {
    throw new HttpsError("invalid-argument", "유효하지 않은 학원 ID입니다.");
  }
  return id;
}

function assertValidNewAcademySlug(academyId: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{1,47}$/.test(academyId)) {
    throw new HttpsError(
      "invalid-argument",
      "학원 ID는 3~48자이며 영문 소문자, 숫자, 밑줄(_), 하이픈(-)만 사용할 수 있습니다.",
    );
  }
}

function assertOwnerOrNotFound(
  academySnap: FirebaseFirestore.DocumentSnapshot,
  uid: string,
  action: "수정" | "삭제",
): void {
  if (!academySnap.exists) {
    throw new HttpsError("not-found", "학원을 찾을 수 없습니다.");
  }
  const ownerUid = academySnap.get("ownerUid");
  if (typeof ownerUid !== "string" || ownerUid !== uid) {
    throw new HttpsError("permission-denied", `학원을 ${action}할 권한이 없습니다.`);
  }
}

/**
 * 오너 전용 — 학원 문서(지정 ID) + 포털 비밀번호(secrets/login)를 한 번에 생성합니다.
 */
export const createAcademyWithPortal = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }

  const academyId = normalizeNewAcademyId(request.data?.academyId);
  assertValidNewAcademySlug(academyId);

  const name = typeof request.data?.name === "string" ? request.data.name.trim() : "";
  if (!name || name.length > 80) {
    throw new HttpsError("invalid-argument", "학원 이름을 1~80자로 입력해 주세요.");
  }

  const portalPassword =
    typeof request.data?.portalPassword === "string" ? request.data.portalPassword : "";
  if (portalPassword.length < 6) {
    throw new HttpsError("invalid-argument", "포털 비밀번호는 6자 이상이어야 합니다.");
  }

  const statusRaw = request.data?.status;
  const status = statusRaw === "archived" ? "archived" : "active";

  const db = admin.firestore();
  const academyRef = db.doc(`academies/${academyId}`);
  const existing = await academyRef.get();
  if (existing.exists) {
    throw new HttpsError("already-exists", "이미 사용 중인 학원 ID입니다.");
  }

  const batch = db.batch();
  batch.set(academyRef, {
    ownerUid: uid,
    name,
    createdAt: FieldValue.serverTimestamp(),
    status,
  });
  batch.set(db.doc(`academies/${academyId}/secrets/login`), {
    portalPassword,
  });
  await batch.commit();

  return {academyId};
});

/**
 * 오너 전용 — 학원 포털 로그인 비밀번호 변경
 */
export const updateAcademyPortalPassword = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }

  const academyId = requireAcademyDocumentId(request.data?.academyId);

  const portalPassword =
    typeof request.data?.portalPassword === "string" ? request.data.portalPassword : "";
  if (portalPassword.length < 6) {
    throw new HttpsError("invalid-argument", "포털 비밀번호는 6자 이상이어야 합니다.");
  }

  const db = admin.firestore();
  const academySnap = await db.doc(`academies/${academyId}`).get();
  assertOwnerOrNotFound(academySnap, uid, "수정");

  await db.doc(`academies/${academyId}/secrets/login`).set({portalPassword}, {merge: true});
  return {ok: true};
});

/**
 * 오너 전용 — 학원 문서 + 포털 시크릿 문서 삭제
 */
export const deleteOwnerAcademy = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }

  const academyId = requireAcademyDocumentId(request.data?.academyId);

  const db = admin.firestore();
  const academyRef = db.doc(`academies/${academyId}`);
  const academySnap = await academyRef.get();
  assertOwnerOrNotFound(academySnap, uid, "삭제");

  const batch = db.batch();
  batch.delete(academyRef);
  batch.delete(db.doc(`academies/${academyId}/secrets/login`));
  await batch.commit();

  return {ok: true};
});

/**
 * 학원 포털 로그인
 */
export const signInAcademy = onCall(async (request) => {
  const academyId = requireAcademyDocumentId(request.data?.academyId);
  const password = typeof request.data?.password === "string" ? request.data.password : "";

  if (!password) {
    throw new HttpsError("invalid-argument", "학원 ID와 비밀번호를 입력해 주세요.");
  }

  const academySnap = await admin.firestore().doc(`academies/${academyId}`).get();
  if (!academySnap.exists) {
    throw new HttpsError("not-found", "학원을 찾을 수 없습니다.");
  }

  const secretSnap = await admin
    .firestore()
    .doc(`academies/${academyId}/secrets/login`)
    .get();

  if (!secretSnap.exists) {
    logger.warn("Academy secrets/login missing", {academyId});
    throw new HttpsError("failed-precondition", "학원 로그인이 아직 설정되지 않았습니다.");
  }

  const portalPassword = secretSnap.get("portalPassword");
  if (typeof portalPassword !== "string" || portalPassword.length === 0) {
    throw new HttpsError("failed-precondition", "학원 로그인이 아직 설정되지 않았습니다.");
  }

  if (password !== portalPassword) {
    throw new HttpsError("permission-denied", "비밀번호가 올바르지 않습니다.");
  }

  const uid = `academy_${academyId.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 100)}`;
  const customToken = await admin.auth().createCustomToken(uid, {
    role: "academy",
    academyId,
  });

  return {customToken};
});

export {
  activateParent,
  deactivateParent,
  deleteParentInvite,
  finalizeParentOnboarding,
  getParentActivationState,
  listParentChildrenStudents,
  registerParentInvite,
  sendParentInvitation,
  updateParentInvite,
} from "./parents";
export {
  activateTeacher,
  deactivateTeacher,
  deleteTeacherInvite,
  finalizeTeacherOnboarding,
  getTeacherActivationState,
  listTeacherAssignedStudents,
  registerTeacherInvite,
  sendTeacherInvitation,
  updateTeacherInvite,
} from "./teachers";
