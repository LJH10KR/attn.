import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as nodemailer from "nodemailer";

type TeacherStatus =
  | "invitation_needed"
  | "invitation_sent"
  | "pending_registration"
  | "active"
  | "inactive";

const TEACHER_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

function invitationExpiresAtFromNow(): Timestamp {
  return Timestamp.fromMillis(Date.now() + TEACHER_INVITE_TTL_MS);
}

function getAppOrigin(): string {
  const o = process.env.APP_ORIGIN?.trim();
  return o && o.length > 0 ? o.replace(/\/$/, "") : "http://127.0.0.1:3000";
}

function isFunctionsEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true";
}

async function assertCanManageAcademy(
  db: admin.firestore.Firestore,
  academyId: string,
  uid: string,
  token: admin.auth.DecodedIdToken,
): Promise<void> {
  const academySnap = await db.doc(`academies/${academyId}`).get();
  if (!academySnap.exists) {
    throw new HttpsError("not-found", "학원을 찾을 수 없습니다.");
  }
  const ownerUid = academySnap.get("ownerUid");
  if (typeof ownerUid === "string" && ownerUid === uid) {
    return;
  }
  if (token.role === "academy" && token.academyId === academyId) {
    return;
  }
  throw new HttpsError("permission-denied", "학원을 관리할 권한이 없습니다.");
}

function normalizeEmail(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!s || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    throw new HttpsError("invalid-argument", "유효한 이메일을 입력해 주세요.");
  }
  return s;
}

function randomPassword(): string {
  return crypto.randomBytes(24).toString("base64url") + "Aa1!";
}

async function sendInviteEmail(
  to: string,
  displayName: string,
  resetLink: string,
  verifyLink: string,
): Promise<void> {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const from = process.env.SMTP_FROM?.trim() || user;

  const body = [
    `${displayName} 선생님, 안녕하세요.`,
    "",
    "학원에서 초청 메일을 보냈습니다. 아래 순서로 진행해 주세요.",
    "",
    "1) 비밀번호 설정 (먼저 진행)",
    resetLink,
    "",
    "2) 이메일 인증",
    verifyLink,
    "",
    "완료 후 attn.에 선생님으로 로그인할 수 있습니다.",
    "",
    "※ 학원에서 안내하는 초청 완료 기한은 발송 시점부터 24시간입니다. 링크가 동작하지 않으면 학원에 재발송을 요청해 주세요.",
    "",
    "감사합니다.",
  ].join("\n");

  if (!host || !from) {
    logger.warn("SMTP 미설정 — 링크는 로그에만 출력됩니다.", { to });
    logger.info("teacher_invite_links", { to, resetLink, verifyLink });
    if (!isFunctionsEmulator()) {
      throw new HttpsError(
        "failed-precondition",
        "초청 메일 발송을 위해 Functions 환경 변수 SMTP_HOST, SMTP_FROM 등을 설정해 주세요.",
      );
    }
    return;
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
  });

  await transporter.sendMail({
    from,
    to,
    subject: "[attn.] 학원 선생님 초청 — 비밀번호 설정 및 이메일 인증",
    text: body,
  });
}

export const registerTeacherInvite = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  if (!academyId) {
    throw new HttpsError("invalid-argument", "학원 ID가 필요합니다.");
  }

  const email = normalizeEmail(request.data?.email);
  const displayName =
    typeof request.data?.displayName === "string" ? request.data.displayName.trim() : "";
  if (!displayName || displayName.length > 60) {
    throw new HttpsError("invalid-argument", "이름을 1~60자로 입력해 주세요.");
  }
  const subject =
    typeof request.data?.subject === "string" ? request.data.subject.trim().slice(0, 80) : "";
  const phone =
    typeof request.data?.phone === "string" ? request.data.phone.trim().slice(0, 30) : "";

  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, uid, token);

  const col = db.collection(`academies/${academyId}/teachers`);
  const dup = await col.where("email", "==", email).limit(5).get();
  if (!dup.empty) {
    throw new HttpsError("already-exists", "이미 등록된 이메일입니다.");
  }

  const ref = col.doc();
  await ref.set({
    email,
    displayName,
    subject: subject || null,
    phone: phone || null,
    status: "invitation_needed" satisfies TeacherStatus,
    academyId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { teacherId: ref.id };
});

export const updateTeacherInvite = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const teacherId =
    typeof request.data?.teacherId === "string" ? request.data.teacherId.trim() : "";
  if (!academyId || !teacherId) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, uid, token);

  const ref = db.doc(`academies/${academyId}/teachers/${teacherId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "선생님 정보를 찾을 수 없습니다.");
  }
  const st = snap.get("status") as TeacherStatus;
  if (st !== "invitation_needed") {
    throw new HttpsError("failed-precondition", "초청 전에만 수정할 수 있습니다.");
  }

  const displayName =
    typeof request.data?.displayName === "string" ? request.data.displayName.trim() : "";
  if (!displayName || displayName.length > 60) {
    throw new HttpsError("invalid-argument", "이름을 1~60자로 입력해 주세요.");
  }
  const email = normalizeEmail(request.data?.email);
  const subject =
    typeof request.data?.subject === "string" ? request.data.subject.trim().slice(0, 80) : "";
  const phone =
    typeof request.data?.phone === "string" ? request.data.phone.trim().slice(0, 30) : "";

  const dup = await db
    .collection(`academies/${academyId}/teachers`)
    .where("email", "==", email)
    .limit(5)
    .get();
  const other = dup.docs.find((d) => d.id !== teacherId);
  if (other) {
    throw new HttpsError("already-exists", "이미 사용 중인 이메일입니다.");
  }

  await ref.update({
    email,
    displayName,
    subject: subject || null,
    phone: phone || null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

export const sendTeacherInvitation = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const teacherId =
    typeof request.data?.teacherId === "string" ? request.data.teacherId.trim() : "";
  if (!academyId || !teacherId) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, uid, token);

  const docRef = db.doc(`academies/${academyId}/teachers/${teacherId}`);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "선생님 정보를 찾을 수 없습니다.");
  }
  const data = snap.data()!;
  const email = typeof data.email === "string" ? data.email : "";
  const displayName = typeof data.displayName === "string" ? data.displayName : "";
  if (!email) {
    throw new HttpsError("failed-precondition", "이메일이 없습니다.");
  }

  const appOrigin = getAppOrigin();
  const continueAfterInvite = `${appOrigin}/teacher/complete?academyId=${encodeURIComponent(academyId)}`;

  const buildLinks = () =>
    Promise.all([
      admin.auth().generatePasswordResetLink(email, {
        url: continueAfterInvite,
        handleCodeInApp: false,
      }),
      admin.auth().generateEmailVerificationLink(email, {
        url: continueAfterInvite,
        handleCodeInApp: false,
      }),
    ]);

  if (data.status === "invitation_sent") {
    const [resetLink, verifyLink] = await buildLinks();
    await sendInviteEmail(email, displayName, resetLink, verifyLink);
    await docRef.update({
      invitationExpiresAt: invitationExpiresAtFromNow(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    const out: {
      ok: true;
      authUid: string;
      resent: true;
      debugLinks?: { resetLink: string; verifyLink: string };
    } = {
      ok: true,
      authUid: typeof data.authUid === "string" ? data.authUid : teacherId,
      resent: true,
    };
    if (isFunctionsEmulator()) {
      out.debugLinks = { resetLink, verifyLink };
    }
    return out;
  }

  if (data.status !== "invitation_needed") {
    throw new HttpsError("failed-precondition", "초청이 필요한 상태의 선생님만 발송할 수 있습니다.");
  }

  let userRecord: admin.auth.UserRecord;
  try {
    userRecord = await admin.auth().getUserByEmail(email);
    throw new HttpsError(
      "already-exists",
      "이미 Firebase에 등록된 이메일입니다. 다른 이메일로 등록하거나 기존 계정을 확인해 주세요.",
    );
  } catch (e: unknown) {
    if (e instanceof HttpsError) {
      throw e;
    }
    const code = (e as { code?: string }).code;
    if (code === "auth/user-not-found") {
      userRecord = await admin.auth().createUser({
        email,
        password: randomPassword(),
        displayName,
        emailVerified: false,
        disabled: false,
      });
    } else {
      throw e;
    }
  }

  const authUid = userRecord.uid;
  const [resetLink, verifyLink] = await buildLinks();

  await sendInviteEmail(email, displayName, resetLink, verifyLink);

  const newRef = db.doc(`academies/${academyId}/teachers/${authUid}`);
  const batch = db.batch();
  batch.set(newRef, {
    ...data,
    email,
    displayName,
    authUid,
    status: "invitation_sent" satisfies TeacherStatus,
    invitedAt: FieldValue.serverTimestamp(),
    invitationExpiresAt: invitationExpiresAtFromNow(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  if (teacherId !== authUid) {
    batch.delete(docRef);
  }
  await batch.commit();

  const out: { ok: true; authUid: string; debugLinks?: { resetLink: string; verifyLink: string } } =
    { ok: true, authUid };
  if (isFunctionsEmulator()) {
    out.debugLinks = { resetLink, verifyLink };
  }
  return out;
});

function teacherDocAcademyId(ref: admin.firestore.DocumentReference): string | null {
  const m = ref.path.match(/^academies\/([^/]+)\/teachers\//);
  return m ? m[1] : null;
}

export const finalizeTeacherOnboarding = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid } = request.auth;

  const academyIdFilter =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";

  const user = await admin.auth().getUser(uid);
  if (!user.emailVerified) {
    throw new HttpsError("failed-precondition", "이메일 인증을 먼저 완료해 주세요.");
  }

  const db = admin.firestore();
  const snaps = await db.collectionGroup("teachers").where("authUid", "==", uid).limit(25).get();

  let candidates = snaps.docs.filter((d) => {
    const s = d.data().status as TeacherStatus;
    return s === "invitation_sent" || s === "pending_registration";
  });

  if (academyIdFilter) {
    candidates = candidates.filter((d) => teacherDocAcademyId(d.ref) === academyIdFilter);
  }

  if (candidates.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      academyIdFilter
        ? "해당 학원에서 이 계정으로 처리할 선생님 초청을 찾을 수 없습니다."
        : "해당 계정으로 연결된 선생님 초청을 찾을 수 없습니다. URL에 학원 정보가 있으면 그대로 두고, 초청받은 이메일로 로그인했는지 확인해 주세요.",
    );
  }

  /** 동일 계정이 여러 학원에 있을 수 있음 — 아직 마칠 초청(invitation_sent)을 우선 */
  const teacherDoc =
    candidates.find((d) => (d.data().status as TeacherStatus) === "invitation_sent") ??
    candidates[0];

  if ((teacherDoc.data().status as TeacherStatus) === "pending_registration") {
    return { ok: true, alreadyComplete: true };
  }

  const d = teacherDoc.data();
  const exp = d.invitationExpiresAt as Timestamp | undefined;
  const invited = d.invitedAt as Timestamp | undefined;
  const deadlineMs = exp?.toMillis() ?? (invited ? invited.toMillis() + TEACHER_INVITE_TTL_MS : 0);
  if (deadlineMs > 0 && Date.now() > deadlineMs) {
    throw new HttpsError(
      "failed-precondition",
      "초청 유효 시간(24시간)이 지났습니다. 학원에 초청 재발송을 요청해 주세요.",
    );
  }

  await teacherDoc.ref.update({
    status: "pending_registration" satisfies TeacherStatus,
    onboardingCompleteAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { ok: true };
});

export const activateTeacher = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid: callerUid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const teacherAuthUid =
    typeof request.data?.teacherAuthUid === "string" ? request.data.teacherAuthUid.trim() : "";
  if (!academyId || !teacherAuthUid) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, callerUid, token);

  const ref = db.doc(`academies/${academyId}/teachers/${teacherAuthUid}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "선생님 정보를 찾을 수 없습니다.");
  }
  const st = snap.get("status") as TeacherStatus;
  if (st !== "pending_registration" && st !== "inactive") {
    throw new HttpsError("failed-precondition", "활성화할 수 있는 상태가 아닙니다.");
  }

  await ref.update({
    status: "active" satisfies TeacherStatus,
    activatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await admin.auth().setCustomUserClaims(teacherAuthUid, {
    role: "teacher",
    academyId,
  });

  return { ok: true };
});

export const deactivateTeacher = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid: callerUid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const teacherAuthUid =
    typeof request.data?.teacherAuthUid === "string" ? request.data.teacherAuthUid.trim() : "";
  if (!academyId || !teacherAuthUid) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, callerUid, token);

  const ref = db.doc(`academies/${academyId}/teachers/${teacherAuthUid}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "선생님 정보를 찾을 수 없습니다.");
  }
  if (snap.get("status") !== "active") {
    throw new HttpsError("failed-precondition", "활성 상태의 선생님만 비활성화할 수 있습니다.");
  }

  await ref.update({
    status: "inactive" satisfies TeacherStatus,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await admin.auth().setCustomUserClaims(teacherAuthUid, {
    role: "teacher",
    academyId,
    teacherDisabled: true,
  });

  return { ok: true };
});

export const deleteTeacherInvite = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid: callerUid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const teacherId =
    typeof request.data?.teacherId === "string" ? request.data.teacherId.trim() : "";
  if (!academyId || !teacherId) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, callerUid, token);

  const ref = db.doc(`academies/${academyId}/teachers/${teacherId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "선생님 정보를 찾을 수 없습니다.");
  }
  const st = snap.get("status") as TeacherStatus;
  if (st === "pending_registration") {
    throw new HttpsError(
      "failed-precondition",
      "등록 대기 중인 선생님은 삭제할 수 없습니다. 활성 처리 후 비활성화해 주세요.",
    );
  }

  const authUid = (snap.get("authUid") as string | undefined) || teacherId;

  await ref.delete();

  if (st === "active" || st === "invitation_sent" || st === "inactive") {
    try {
      await admin.auth().deleteUser(authUid);
    } catch (e) {
      logger.warn("deleteTeacherInvite: auth delete skipped", { authUid, e });
    }
  }

  return { ok: true };
});
