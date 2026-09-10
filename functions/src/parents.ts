import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as nodemailer from "nodemailer";
import { createShortAuthLink, getAppOrigin } from "./auth-short-links";
import { reconcileUserActivationMirror } from "./user-activation-mirror";
import { getRequireStudentCheckInPin } from "./kiosk";
import {
  deleteAttnLoginIndexForMember,
  deleteMemberLoginSecrets,
  deleteStudentDocs,
  purgeUserFirestoreData,
} from "./lib/firestore-cleanup";

type ParentStatus =
  | "invitation_needed"
  | "invitation_sent"
  | "pending_registration"
  | "active"
  | "inactive";

const PARENT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

function invitationExpiresAtFromNow(): Timestamp {
  return Timestamp.fromMillis(Date.now() + PARENT_INVITE_TTL_MS);
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

function parseChildrenCount(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 50 || !Number.isInteger(n)) {
    throw new HttpsError("invalid-argument", "자녀 수는 0~50 사이의 정수로 입력해 주세요.");
  }
  return n;
}

async function sendParentInviteEmail(
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
    `${displayName} 학부모님, 안녕하세요.`,
    "",
    "학원에서 학부모 초청 메일을 보냈습니다. 아래 순서로 진행해 주세요.",
    "",
    "1) 비밀번호 설정 (먼저 진행)",
    resetLink,
    "",
    "2) 이메일 인증",
    verifyLink,
    "",
    "완료 후 attn.에 학부모로 로그인할 수 있습니다.",
    "",
    "※ 학원에서 안내하는 초청 완료 기한은 발송 시점부터 24시간입니다. 링크가 동작하지 않으면 학원에 재발송을 요청해 주세요.",
    "",
    "감사합니다.",
  ].join("\n");

  if (!host || !from) {
    logger.warn("SMTP 미설정 — 학부모 초청 링크는 로그에만 출력됩니다.", { to });
    logger.info("parent_invite_links", { to, resetLink, verifyLink });
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
    subject: "[attn.] 학원 학부모 초청 — 비밀번호 설정 및 이메일 인증",
    text: body,
  });
}

export const registerParentInvite = onCall(async (request) => {
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
  const phone =
    typeof request.data?.phone === "string" ? request.data.phone.trim().slice(0, 30) : "";
  const emergencyContact =
    typeof request.data?.emergencyContact === "string"
      ? request.data.emergencyContact.trim().slice(0, 30)
      : "";
  const childrenCount = parseChildrenCount(request.data?.childrenCount ?? 0);

  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, uid, token);

  const col = db.collection(`academies/${academyId}/parents`);
  const dup = await col.where("email", "==", email).limit(5).get();
  if (!dup.empty) {
    throw new HttpsError("already-exists", "이미 등록된 이메일입니다.");
  }

  const ref = col.doc();
  await ref.set({
    email,
    displayName,
    phone: phone || null,
    emergencyContact: emergencyContact || null,
    childrenCount,
    status: "invitation_needed" satisfies ParentStatus,
    academyId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { parentId: ref.id };
});

export const updateParentInvite = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const parentId =
    typeof request.data?.parentId === "string" ? request.data.parentId.trim() : "";
  if (!academyId || !parentId) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, uid, token);

  const ref = db.doc(`academies/${academyId}/parents/${parentId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "학부모 정보를 찾을 수 없습니다.");
  }
  const st = snap.get("status") as ParentStatus;
  if (st !== "invitation_needed") {
    throw new HttpsError("failed-precondition", "초청 전에만 수정할 수 있습니다.");
  }

  const displayName =
    typeof request.data?.displayName === "string" ? request.data.displayName.trim() : "";
  if (!displayName || displayName.length > 60) {
    throw new HttpsError("invalid-argument", "이름을 1~60자로 입력해 주세요.");
  }
  const email = normalizeEmail(request.data?.email);
  const phone =
    typeof request.data?.phone === "string" ? request.data.phone.trim().slice(0, 30) : "";
  const emergencyContact =
    typeof request.data?.emergencyContact === "string"
      ? request.data.emergencyContact.trim().slice(0, 30)
      : "";
  const rawCc = request.data?.childrenCount;
  const childrenCount =
    rawCc === undefined || rawCc === null
      ? parseChildrenCount(snap.get("childrenCount") ?? 0)
      : parseChildrenCount(rawCc);

  const dup = await db
    .collection(`academies/${academyId}/parents`)
    .where("email", "==", email)
    .limit(5)
    .get();
  const other = dup.docs.find((d) => d.id !== parentId);
  if (other) {
    throw new HttpsError("already-exists", "이미 사용 중인 이메일입니다.");
  }

  await ref.update({
    email,
    displayName,
    phone: phone || null,
    emergencyContact: emergencyContact || null,
    childrenCount,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

export const sendParentInvitation = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const parentId =
    typeof request.data?.parentId === "string" ? request.data.parentId.trim() : "";
  if (!academyId || !parentId) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, uid, token);

  const docRef = db.doc(`academies/${academyId}/parents/${parentId}`);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "학부모 정보를 찾을 수 없습니다.");
  }
  const data = snap.data()!;
  const email = typeof data.email === "string" ? data.email : "";
  const displayName = typeof data.displayName === "string" ? data.displayName : "";
  if (!email) {
    throw new HttpsError("failed-precondition", "이메일이 없습니다.");
  }

  const appOrigin = getAppOrigin();
  const continueAfterInvite = `${appOrigin}/parent/complete?academyId=${encodeURIComponent(academyId)}`;

  const buildLinks = async (inviteAuthUid?: string) => {
    const [rawResetLink, rawVerifyLink] = await Promise.all([
      admin.auth().generatePasswordResetLink(email, {
        url: continueAfterInvite,
        handleCodeInApp: false,
      }),
      admin.auth().generateEmailVerificationLink(email, {
        url: continueAfterInvite,
        handleCodeInApp: false,
      }),
    ]);
    const [shortResetLink, shortVerifyLink] = await Promise.all([
      createShortAuthLink({
        targetUrl: rawResetLink,
        purpose: "parent_reset",
        academyId,
        uid: inviteAuthUid,
        email,
      }),
      createShortAuthLink({
        targetUrl: rawVerifyLink,
        purpose: "parent_verify",
        academyId,
        uid: inviteAuthUid,
        email,
      }),
    ]);
    return { shortResetLink, shortVerifyLink, rawResetLink, rawVerifyLink };
  };

  if (data.status === "invitation_sent") {
    const inviteAuthUid = typeof data.authUid === "string" ? data.authUid : parentId;
    const links = await buildLinks(inviteAuthUid);
    await sendParentInviteEmail(email, displayName, links.shortResetLink, links.shortVerifyLink);
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
      authUid: inviteAuthUid,
      resent: true,
    };
    if (isFunctionsEmulator()) {
      out.debugLinks = { resetLink: links.rawResetLink, verifyLink: links.rawVerifyLink };
    }
    return out;
  }

  if (data.status !== "invitation_needed") {
    throw new HttpsError("failed-precondition", "초청이 필요한 상태의 학부모만 발송할 수 있습니다.");
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
  const links = await buildLinks(authUid);

  await sendParentInviteEmail(email, displayName, links.shortResetLink, links.shortVerifyLink);

  const newRef = db.doc(`academies/${academyId}/parents/${authUid}`);
  const batch = db.batch();
  batch.set(newRef, {
    ...data,
    email,
    displayName,
    authUid,
    status: "invitation_sent" satisfies ParentStatus,
    invitedAt: FieldValue.serverTimestamp(),
    invitationExpiresAt: invitationExpiresAtFromNow(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  if (parentId !== authUid) {
    batch.delete(docRef);
  }
  await batch.commit();

  const out: { ok: true; authUid: string; debugLinks?: { resetLink: string; verifyLink: string } } =
    { ok: true, authUid };
  if (isFunctionsEmulator()) {
    out.debugLinks = { resetLink: links.rawResetLink, verifyLink: links.rawVerifyLink };
  }
  return out;
});

function parentDocAcademyId(ref: admin.firestore.DocumentReference): string | null {
  const m = ref.path.match(/^academies\/([^/]+)\/parents\//);
  return m ? m[1] : null;
}

function studentCheckInSecretPath(academyId: string, studentId: string): string {
  return `academies/${academyId}/students/${studentId}/serverSecrets/checkIn`;
}

function serializeStudentDocForCallable(
  d: QueryDocumentSnapshot,
  opts?: { hasCheckInPin?: boolean },
): {
  id: string;
  parentUserId: string;
  name: string;
  age: number;
  phone: string;
  emergencyContact: string;
  assignedTeacherUids: string[];
  assignedTeacherUid: string | null;
  createdAtMillis: number | null;
  hasCheckInPin?: boolean;
  tuitionDueDayOfMonth: number | null;
  tuitionAmount: number | null;
  weeklySessionCount: number | null;
  pricePerSession: number | null;
  sessionBalance: number | null;
  extraSessionDates: string[];
  hasPendingPaymentReminder: boolean;
} {
  const data = d.data();
  const createdAt = data.createdAt as Timestamp | undefined;
  const createdAtMillis =
    createdAt && typeof createdAt.toMillis === "function" ? createdAt.toMillis() : null;
  const rawUids = data.assignedTeacherUids;
  const assignedTeacherUids =
    Array.isArray(rawUids) && rawUids.every((x: unknown) => typeof x === "string")
      ? (rawUids as string[]).filter((x) => x.length > 0)
      : [];
  const legacyUid = data.assignedTeacherUid;
  const rawDay = data.tuitionDueDayOfMonth;
  const tuitionDueDayOfMonth =
    typeof rawDay === "number" && Number.isInteger(rawDay) && rawDay >= 1 && rawDay <= 31
      ? rawDay
      : null;
  const rawWeeklyCount = data.weeklySessionCount;
  const weeklySessionCount =
    typeof rawWeeklyCount === "number" && Number.isInteger(rawWeeklyCount) && rawWeeklyCount >= 1 && rawWeeklyCount <= 7
      ? rawWeeklyCount
      : null;
  const rawPrice = data.pricePerSession;
  const pricePerSession =
    typeof rawPrice === "number" && rawPrice >= 0 ? rawPrice : null;
  const rawBalance = data.sessionBalance;
  const sessionBalance =
    typeof rawBalance === "number" && Number.isInteger(rawBalance) ? rawBalance : null;
  const rawExtraDates = data.extraSessionDates;
  const extraSessionDates =
    Array.isArray(rawExtraDates)
      ? (rawExtraDates as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
  return {
    id: d.id,
    parentUserId: typeof data.parentUserId === "string" ? data.parentUserId : "",
    name: typeof data.name === "string" ? data.name : "",
    age: typeof data.age === "number" && Number.isFinite(data.age) ? Math.floor(data.age) : 0,
    phone: typeof data.phone === "string" ? data.phone : "",
    emergencyContact: typeof data.emergencyContact === "string" ? data.emergencyContact : "",
    assignedTeacherUids,
    assignedTeacherUid:
      typeof legacyUid === "string" && legacyUid.length > 0 ? legacyUid : null,
    createdAtMillis,
    ...(opts?.hasCheckInPin !== undefined ? { hasCheckInPin: opts.hasCheckInPin } : {}),
    tuitionDueDayOfMonth,
    tuitionAmount: typeof data.tuitionAmount === "number" ? data.tuitionAmount : null,
    weeklySessionCount,
    pricePerSession,
    sessionBalance,
    extraSessionDates,
    hasPendingPaymentReminder:
      data.sentSessionPaymentReminder === true && !data.tuitionReminderConfirmedAt,
  };
}

export const finalizeParentOnboarding = onCall(async (request) => {
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
  const snaps = await db.collectionGroup("parents").where("authUid", "==", uid).limit(25).get();

  let candidates = snaps.docs.filter((d) => {
    const s = d.data().status as ParentStatus;
    return s === "invitation_sent" || s === "pending_registration";
  });

  if (academyIdFilter) {
    candidates = candidates.filter((d) => parentDocAcademyId(d.ref) === academyIdFilter);
  }

  if (candidates.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      academyIdFilter
        ? "해당 학원에서 이 계정으로 처리할 학부모 초청을 찾을 수 없습니다."
        : "해당 계정으로 연결된 학부모 초청을 찾을 수 없습니다. URL에 학원 정보가 있으면 그대로 두고, 초청받은 이메일로 로그인했는지 확인해 주세요.",
    );
  }

  const parentDoc =
    candidates.find((d) => (d.data().status as ParentStatus) === "invitation_sent") ??
    candidates[0];

  if ((parentDoc.data().status as ParentStatus) === "pending_registration") {
    await admin.auth().updateUser(uid, { disabled: true });
    return { ok: true, alreadyComplete: true };
  }

  const d = parentDoc.data();
  const exp = d.invitationExpiresAt as Timestamp | undefined;
  const invited = d.invitedAt as Timestamp | undefined;
  const deadlineMs = exp?.toMillis() ?? (invited ? invited.toMillis() + PARENT_INVITE_TTL_MS : 0);
  if (deadlineMs > 0 && Date.now() > deadlineMs) {
    throw new HttpsError(
      "failed-precondition",
      "초청 유효 시간(24시간)이 지났습니다. 학원에 초청 재발송을 요청해 주세요.",
    );
  }

  await parentDoc.ref.update({
    status: "pending_registration" satisfies ParentStatus,
    onboardingCompleteAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await admin.auth().updateUser(uid, { disabled: true });

  return { ok: true };
});

const enforceAppCheckOnParentState = process.env.ENFORCE_APP_CHECK === "1";

export const getParentActivationState = onCall(
  { cors: true, enforceAppCheck: enforceAppCheckOnParentState },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
    }
    const { uid } = request.auth;

    const db = admin.firestore();
    const { parent } = await reconcileUserActivationMirror(db, uid, "reconcile");

    return {
      ok: true,
      anyActive: parent.anyActive,
      primaryStatus: parent.primaryStatus as ParentStatus | null,
      primaryAcademyId: parent.primaryAcademyId,
    };
  },
);

/**
 * 활성 학부모의 자녀(학생) 목록 — `students` 컬렉션 list + 학부모 OR 분기 규칙이
 * 에뮬에서 evaluation error를 낼 수 있어 Admin 조회로 통일합니다.
 */
export const listParentChildrenStudents = onCall(
  { cors: true, enforceAppCheck: enforceAppCheckOnParentState },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
    }
    const uid = request.auth.uid;
    const academyId =
      typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
    if (!academyId) {
      throw new HttpsError("invalid-argument", "학원 ID가 필요합니다.");
    }

    const db = admin.firestore();
    const parentRef = db.doc(`academies/${academyId}/parents/${uid}`);
    const col = db.collection(`academies/${academyId}/students`);

    const [parentSnap, snap, requireStudentCheckInPin] = await Promise.all([
      parentRef.get(),
      col.where("parentUserId", "==", uid).get(),
      getRequireStudentCheckInPin(db, academyId),
    ]);
    if (!parentSnap.exists || parentSnap.get("status") !== "active") {
      throw new HttpsError(
        "permission-denied",
        "이 학원의 활성 학부모만 자녀 학생 목록을 조회할 수 있습니다.",
      );
    }

    const pinRefs = snap.docs.map((d) => db.doc(studentCheckInSecretPath(academyId, d.id)));
    const pinSnaps = pinRefs.length ? await db.getAll(...pinRefs) : [];
    const students = snap.docs.map((d, i) => {
      const pinSnap = pinSnaps[i];
      const hasCheckInPin =
        typeof pinSnap?.get("pinHash") === "string" && (pinSnap.get("pinHash") as string).length > 0;
      return serializeStudentDocForCallable(d, { hasCheckInPin });
    });

    return {
      ok: true as const,
      students,
      kiosk: { requireStudentCheckInPin },
    };
  },
);

export const activateParent = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid: callerUid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const parentAuthUid =
    typeof request.data?.parentAuthUid === "string" ? request.data.parentAuthUid.trim() : "";
  if (!academyId || !parentAuthUid) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, callerUid, token);

  const ref = db.doc(`academies/${academyId}/parents/${parentAuthUid}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "학부모 정보를 찾을 수 없습니다.");
  }
  const st = snap.get("status") as ParentStatus;
  if (st !== "pending_registration" && st !== "inactive") {
    throw new HttpsError("failed-precondition", "활성화할 수 있는 상태가 아닙니다.");
  }

  await ref.update({
    status: "active" satisfies ParentStatus,
    activatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await admin.auth().setCustomUserClaims(parentAuthUid, {
    role: "parent",
    academyId,
    membershipStatus: "active",
  });

  await admin.auth().updateUser(parentAuthUid, { disabled: false });

  return { ok: true };
});

export const deactivateParent = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid: callerUid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const parentAuthUid =
    typeof request.data?.parentAuthUid === "string" ? request.data.parentAuthUid.trim() : "";
  if (!academyId || !parentAuthUid) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, callerUid, token);

  const ref = db.doc(`academies/${academyId}/parents/${parentAuthUid}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "학부모 정보를 찾을 수 없습니다.");
  }
  if (snap.get("status") !== "active") {
    throw new HttpsError("failed-precondition", "활성 상태의 학부모만 비활성화할 수 있습니다.");
  }

  await ref.update({
    status: "inactive" satisfies ParentStatus,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await admin.auth().setCustomUserClaims(parentAuthUid, {
    role: "parent",
    academyId,
    parentDisabled: true,
  });

  await admin.auth().updateUser(parentAuthUid, { disabled: true });

  return { ok: true };
});

export const deleteParentInvite = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid: callerUid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const parentId =
    typeof request.data?.parentId === "string" ? request.data.parentId.trim() : "";
  if (!academyId || !parentId) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, callerUid, token);

  const ref = db.doc(`academies/${academyId}/parents/${parentId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "학부모 정보를 찾을 수 없습니다.");
  }
  const st = snap.get("status") as ParentStatus;
  if (st === "pending_registration") {
    throw new HttpsError(
      "failed-precondition",
      "등록 대기 중인 학부모는 삭제할 수 없습니다. 활성 처리 후 비활성화해 주세요.",
    );
  }

  const authUid = (snap.get("authUid") as string | undefined) || parentId;
  const data = snap.data() ?? {};

  const studentsSnap = await db.collection(`academies/${academyId}/students`).get();
  const studentIds = studentsSnap.docs
    .filter((s) => {
      const pid = s.get("parentUserId");
      return pid === parentId || pid === authUid;
    })
    .map((s) => s.id);
  if (studentIds.length > 0) {
    await deleteStudentDocs(db, academyId, studentIds);
  }

  await deleteMemberLoginSecrets(db, academyId, "parent", parentId);
  await deleteAttnLoginIndexForMember(db, data, authUid);
  await ref.delete();

  if (st === "active" || st === "invitation_sent" || st === "inactive") {
    try {
      await admin.auth().deleteUser(authUid);
    } catch (e) {
      logger.warn("deleteParentInvite: auth delete skipped", { authUid, e });
    }
    await purgeUserFirestoreData(db, authUid);
  }

  return { ok: true };
});

/** 학원·오너 — 학생 삭제(문서 + serverSecrets) */
export const deleteAcademyStudent = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid: callerUid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const studentId =
    typeof request.data?.studentId === "string" ? request.data.studentId.trim() : "";
  if (!academyId || !studentId) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, callerUid, token);

  const ref = db.doc(`academies/${academyId}/students/${studentId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "학생 정보를 찾을 수 없습니다.");
  }

  await deleteStudentDocs(db, academyId, [studentId]);
  return { ok: true };
});
