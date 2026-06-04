import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { attnLoginIndexPath } from "./lib/attn-id";
import { normalizeParentLoginId } from "./lib/parent-login-id";
import { randomTempPassword, type MemberKind } from "./lib/member-credentials";
import { assertCanManageAcademy } from "./lib/academy-access";

async function verifyMemberPassword(
  academyId: string,
  authUid: string,
  role: MemberKind,
  password: string,
): Promise<{ status: string }> {
  const secretSnap = await admin
    .firestore()
    .doc(`academies/${academyId}/${role}s/${authUid}/secrets/login`)
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
    throw new HttpsError("permission-denied", "로그인 번호 또는 비밀번호가 올바르지 않습니다.");
  }
  const memberSnap = await admin
    .firestore()
    .doc(`academies/${academyId}/${role}s/${authUid}`)
    .get();
  if (!memberSnap.exists) {
    throw new HttpsError("not-found", "계정을 찾을 수 없습니다.");
  }
  return { status: (memberSnap.get("status") as string) || "pending_setup" };
}

const PARENT_ATTN_ID_RE = /^\d{5}_\d{2}_\d{4}$/;

async function resolveParentLoginIndex(loginKey: string) {
  const db = admin.firestore();
  const trimmed = loginKey.trim();
  const normalized = normalizeParentLoginId(trimmed);
  const candidates = [normalized];
  if (trimmed !== normalized) {
    candidates.push(trimmed);
  }
  if (PARENT_ATTN_ID_RE.test(trimmed) && !candidates.includes(trimmed)) {
    candidates.push(trimmed);
  }
  for (const key of candidates) {
    const snap = await db.doc(attnLoginIndexPath(key)).get();
    if (snap.exists) {
      return snap;
    }
  }
  return null;
}

async function signInMember(loginKey: string, password: string, role: MemberKind) {
  const indexSnap =
    role === "parent"
      ? await resolveParentLoginIndex(loginKey)
      : await admin.firestore().doc(attnLoginIndexPath(loginKey.trim())).get();
  if (!indexSnap?.exists) {
    throw new HttpsError("not-found", "로그인 번호 또는 비밀번호가 올바르지 않습니다.");
  }
  const academyId = indexSnap.get("academyId");
  const authUid = indexSnap.get("authUid");
  const indexRole = indexSnap.get("role");
  if (
    typeof academyId !== "string" ||
    typeof authUid !== "string" ||
    indexRole !== role
  ) {
    throw new HttpsError("failed-precondition", "계정 정보가 올바르지 않습니다.");
  }
  if (role === "parent" && indexSnap.get("authProvider") === "google") {
    throw new HttpsError(
      "failed-precondition",
      "이 계정은 Google 로그인을 사용합니다. Google로 로그인해 주세요.",
    );
  }

  const { status } = await verifyMemberPassword(academyId, authUid, role, password);

  const customToken = await admin.auth().createCustomToken(authUid, {
    role,
    academyId,
    membershipStatus: status,
  });

  return { customToken, academyId, authUid, membershipStatus: status };
}

export const signInTeacher = onCall(async (request) => {
  const attnId = typeof request.data?.attnId === "string" ? request.data.attnId.trim() : "";
  const password = typeof request.data?.password === "string" ? request.data.password : "";
  if (!attnId || !password) {
    throw new HttpsError("invalid-argument", "로그인 번호와 비밀번호를 입력해 주세요.");
  }
  return signInMember(attnId, password, "teacher");
});

/** 선생님 Google 로그인 — 설정에서 Google 연동(googleLinked)된 계정만 */
export const TEACHER_GOOGLE_LINK_REQUIRED_MSG = "구글 로그인 연동 후 진행해 주세요.";

function teacherAcademyIdFromMemberPath(path: string): string | null {
  const m = path.match(/^academies\/([^/]+)\/teachers\//);
  return m ? m[1] : null;
}

export const signInTeacherGoogle = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Google 로그인 후 다시 시도해 주세요.");
  }
  const uid = request.auth.uid;

  const user = await admin.auth().getUser(uid);
  const hasGoogle = user.providerData.some((p) => p.providerId === "google.com");
  if (!hasGoogle) {
    throw new HttpsError("failed-precondition", "Google 로그인 후 다시 시도해 주세요.");
  }

  const db = admin.firestore();
  const snaps = await db.collectionGroup("teachers").where("authUid", "==", uid).limit(25).get();
  if (snaps.empty) {
    throw new HttpsError("not-found", "연결된 선생님 계정을 찾을 수 없습니다.");
  }

  const linked = snaps.docs.filter((d) => d.get("googleLinked") === true);
  if (linked.length === 0) {
    throw new HttpsError("failed-precondition", TEACHER_GOOGLE_LINK_REQUIRED_MSG);
  }

  const activeLinked = linked.find((d) => d.get("status") === "active");
  const memberDoc = activeLinked ?? linked[0]!;
  const academyId = teacherAcademyIdFromMemberPath(memberDoc.ref.path);
  if (!academyId) {
    throw new HttpsError("failed-precondition", "학원 정보가 올바르지 않습니다.");
  }
  const membershipStatus =
    typeof memberDoc.get("status") === "string" ? memberDoc.get("status") : "pending_setup";

  await admin.auth().setCustomUserClaims(uid, {
    role: "teacher",
    academyId,
    membershipStatus,
  });

  return {
    academyId,
    membershipStatus,
    anyActive: membershipStatus === "active",
  };
});

export const signInParent = onCall(async (request) => {
  const loginId =
    typeof request.data?.loginId === "string"
      ? request.data.loginId.trim()
      : typeof request.data?.attnId === "string"
        ? request.data.attnId.trim()
        : "";
  const password = typeof request.data?.password === "string" ? request.data.password : "";
  if (!loginId || !password) {
    throw new HttpsError("invalid-argument", "로그인 ID와 비밀번호를 입력해 주세요.");
  }
  return signInMember(loginId, password, "parent");
});

/** 최초 비밀번호 변경 + active 전환 */
export const completeMemberFirstLogin = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const uid = request.auth.uid;
  const newPassword =
    typeof request.data?.newPassword === "string" ? request.data.newPassword : "";
  if (newPassword.length < 6) {
    throw new HttpsError("invalid-argument", "비밀번호는 6자 이상이어야 합니다.");
  }

  const token = request.auth.token;
  const role = token.role === "parent" ? "parent" : token.role === "teacher" ? "teacher" : null;
  const academyId = typeof token.academyId === "string" ? token.academyId : "";
  if (!role || !academyId) {
    throw new HttpsError("failed-precondition", "선생님 또는 학부모 계정만 처리할 수 있습니다.");
  }

  const col = role === "teacher" ? "teachers" : "parents";
  const memberRef = admin.firestore().doc(`academies/${academyId}/${col}/${uid}`);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) {
    throw new HttpsError("not-found", "멤버 정보를 찾을 수 없습니다.");
  }

  await admin.auth().updateUser(uid, { password: newPassword });
  await memberRef.update({
    status: "active",
    activatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await admin.firestore().doc(`academies/${academyId}/${col}/${uid}/secrets/login`).set(
    {
      password: newPassword,
      tempPassword: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await admin.auth().setCustomUserClaims(uid, {
    role,
    academyId,
    membershipStatus: "active",
  });

  return { ok: true, membershipStatus: "active" as const };
});

/** 오너/학원 — 임시 비밀번호 재발급 (1회 표시) */
export const regenerateMemberTempPassword = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const memberAuthUid =
    typeof request.data?.memberAuthUid === "string" ? request.data.memberAuthUid.trim() : "";
  const roleRaw = request.data?.role;
  const role: MemberKind = roleRaw === "parent" ? "parent" : "teacher";
  if (!academyId || !memberAuthUid) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, uid, token);

  const col = role === "teacher" ? "teachers" : "parents";
  const memberRef = db.doc(`academies/${academyId}/${col}/${memberAuthUid}`);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) {
    throw new HttpsError("not-found", "계정을 찾을 수 없습니다.");
  }
  const status = memberSnap.get("status");
  if (status === "active") {
    throw new HttpsError(
      "failed-precondition",
      "활성 계정은 임시 비밀번호 재발급 대신 비밀번호 초기화 기능을 사용해 주세요.",
    );
  }

  const tempPassword = randomTempPassword();
  await admin.auth().updateUser(memberAuthUid, { password: tempPassword });
  await db.doc(`academies/${academyId}/${col}/${memberAuthUid}/secrets/login`).set(
    {
      tempPassword,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  const attnId = memberSnap.get("attnId");
  const displayName = memberSnap.get("displayName");

  return {
    attnId: typeof attnId === "string" ? attnId : "",
    displayName: typeof displayName === "string" ? displayName : "",
    tempPassword,
    role,
  };
});

/** 오너/학원 — 미활성 계정 목록 (attnId, 이름, 상태) */
export const listAcademyIssuedAccounts = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  if (!academyId) {
    throw new HttpsError("invalid-argument", "학원 ID가 필요합니다.");
  }

  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, uid, token);

  const [teachersSnap, parentsSnap] = await Promise.all([
    db.collection(`academies/${academyId}/teachers`).get(),
    db.collection(`academies/${academyId}/parents`).get(),
  ]);

  const mapRow = (
    d: FirebaseFirestore.QueryDocumentSnapshot,
    role: MemberKind,
  ) => {
    const data = d.data();
    return {
      authUid: d.id,
      role,
      attnId: typeof data.attnId === "string" ? data.attnId : "",
      displayName: typeof data.displayName === "string" ? data.displayName : "",
      status: typeof data.status === "string" ? data.status : "pending_setup",
    };
  };

  return {
    teachers: teachersSnap.docs.map((d) => mapRow(d, "teacher")),
    parents: parentsSnap.docs.map((d) => mapRow(d, "parent")),
  };
});
