import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { attnLoginIndexPath, PARENT_ATTN_ID_RE, TEACHER_ATTN_ID_RE } from "./lib/attn-id";
import { normalizeMemberLoginId } from "./lib/member-login-id";
import { normalizeParentLoginId } from "./lib/parent-login-id";
import {
  memberCollectionName,
  randomTempPassword,
  type MemberKind,
} from "./lib/member-credentials";
import { assertPermission } from "./lib/academy-access";
import {
  hasLoginSecret,
  passwordSecretFields,
  tempPasswordSecretFields,
  verifyLoginSecret,
} from "./lib/password-hash";
import {
  beginLoginAttempt,
  lockedLoginMessage,
  LOGIN_THROTTLE_RESET,
  loginThrottleFields,
  readLoginThrottle,
} from "./lib/login-throttle";
import { normalizePermissionList } from "./lib/permissions";
import { memberPasswordResetViolation, staffAccountChangeViolation } from "./lib/role-policy";

/** 연속 실패 제한(`login-throttle.ts`)을 거쳐 비밀번호 확인 — 시도 횟수는 검증 전에 올리고 성공하면 초기화 */
async function verifyMemberPassword(
  academyId: string,
  authUid: string,
  role: MemberKind,
  password: string,
): Promise<{ status: string; contactEmail?: string }> {
  const db = admin.firestore();
  const secretRef = db.doc(
    `academies/${academyId}/${memberCollectionName(role)}/${authUid}/secrets/login`,
  );
  const attempt = await db.runTransaction(async (tx) => {
    const snap = await tx.get(secretRef);
    if (!snap.exists) return null;
    const decision = beginLoginAttempt(readLoginThrottle(snap.data()), Date.now());
    if (decision.next) {
      tx.update(secretRef, loginThrottleFields(decision.next));
    }
    return { secret: snap.data(), decision };
  });
  if (!attempt) {
    throw new HttpsError("failed-precondition", "로그인 정보가 설정되지 않았습니다.");
  }
  if (!attempt.decision.allowed) {
    throw new HttpsError("resource-exhausted", lockedLoginMessage(attempt.decision.retryAfterMs));
  }
  if (!(await verifyLoginSecret(attempt.secret, password))) {
    throw new HttpsError("permission-denied", "로그인 ID 또는 비밀번호가 올바르지 않습니다.");
  }
  await secretRef.update(loginThrottleFields(LOGIN_THROTTLE_RESET));
  const memberSnap = await admin
    .firestore()
    .doc(`academies/${academyId}/${memberCollectionName(role)}/${authUid}`)
    .get();
  if (!memberSnap.exists) {
    throw new HttpsError("not-found", "계정을 찾을 수 없습니다.");
  }
  const status = (memberSnap.get("status") as string) || "pending_setup";
  const contactEmail =
    role === "parent" && status === "pending_email_verification"
      ? typeof memberSnap.get("contactEmail") === "string"
        ? memberSnap.get("contactEmail")
        : undefined
      : undefined;
  return { status, contactEmail };
}

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

async function resolveTeacherLoginIndex(loginKey: string) {
  const db = admin.firestore();
  const trimmed = loginKey.trim();
  const normalized = normalizeMemberLoginId(trimmed);
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (key: string) => {
    if (key && !seen.has(key)) {
      seen.add(key);
      candidates.push(key);
    }
  };
  push(trimmed);
  push(normalized);
  if (TEACHER_ATTN_ID_RE.test(trimmed)) {
    push(trimmed);
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
      : role === "teacher"
        ? await resolveTeacherLoginIndex(loginKey)
        : await admin.firestore().doc(attnLoginIndexPath(loginKey.trim())).get();
  if (!indexSnap?.exists) {
    throw new HttpsError(
      "not-found",
      role === "teacher" || role === "parent"
        ? "로그인 ID 또는 비밀번호가 올바르지 않습니다."
        : "로그인 번호 또는 비밀번호가 올바르지 않습니다.",
    );
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

  const { status, contactEmail } = await verifyMemberPassword(
    academyId,
    authUid,
    role,
    password,
  );

  // 커스텀 토큰 클레임은 세션 한정 — 갱신 시 서버에 저장된 클레임이 필요합니다.
  await admin.auth().setCustomUserClaims(authUid, {
    role,
    academyId,
    membershipStatus: status,
  });

  const customToken = await admin.auth().createCustomToken(authUid, {
    role,
    academyId,
    membershipStatus: status,
  });

  return {
    customToken,
    academyId,
    authUid,
    membershipStatus: status,
    ...(contactEmail ? { contactEmail } : {}),
  };
}

export const signInTeacher = onCall(async (request) => {
  const loginId =
    typeof request.data?.loginId === "string" ? request.data.loginId.trim() : "";
  const legacyAttnId =
    typeof request.data?.attnId === "string" ? request.data.attnId.trim() : "";
  const loginKey = loginId || legacyAttnId;
  const password = typeof request.data?.password === "string" ? request.data.password : "";
  if (!loginKey || !password) {
    throw new HttpsError("invalid-argument", "로그인 ID와 비밀번호를 입력해 주세요.");
  }
  return signInMember(loginKey, password, "teacher");
});

/** 선생님 Google 로그인 — 설정에서 Google 연동(googleLinked)된 계정만 */
export const TEACHER_GOOGLE_LINK_REQUIRED_MSG = "구글 로그인 연동 후 진행해 주세요.";

function teacherAcademyIdFromMemberPath(path: string): string | null {
  const m = path.match(/^academies\/([^/]+)\/staff\//);
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
  const snaps = await db.collectionGroup("staff").where("authUid", "==", uid).limit(25).get();
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

  const col = role === "teacher" ? "staff" : "parents";
  const memberRef = admin.firestore().doc(`academies/${academyId}/${col}/${uid}`);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) {
    throw new HttpsError("not-found", "멤버 정보를 찾을 수 없습니다.");
  }
  // 학원이 직접 만들어 준 계정의 첫 로그인만 — 승인 대기(초대 링크 가입)·비활성 계정이 스스로 활성화하지 못하게
  if (memberSnap.get("status") !== "pending_setup") {
    throw new HttpsError("failed-precondition", "첫 로그인 비밀번호 설정이 필요한 계정이 아닙니다.");
  }

  await admin.auth().updateUser(uid, { password: newPassword });
  await memberRef.update({
    status: "active",
    activatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await memberRef
    .collection("secrets")
    .doc("login")
    .set(await passwordSecretFields(newPassword), { merge: true });

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
  const actor = await assertPermission(
    db,
    academyId,
    uid,
    token,
    role === "teacher" ? "settings.members" : "operations.parents",
  );

  const memberRef = db.doc(`academies/${academyId}/${memberCollectionName(role)}/${memberAuthUid}`);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) {
    throw new HttpsError("not-found", "계정을 찾을 수 없습니다.");
  }
  if (role === "teacher") {
    // 직원이 상위 관리자 계정의 임시 비밀번호를 받아 로그인하는 것(계정 탈취) 차단
    const violation = staffAccountChangeViolation(actor, {
      staffId: memberAuthUid,
      staffCurrentPermissions: normalizePermissionList(memberSnap.get("permissions")),
    });
    if (violation) {
      throw new HttpsError("permission-denied", violation);
    }
  }
  // 첫 로그인 전 계정만 — 다른 상태에서 임시 비밀번호로 바꾸면 첫 로그인 흐름과 어긋남(화면도 이 상태에서만 버튼 표시)
  if (memberSnap.get("status") !== "pending_setup") {
    throw new HttpsError(
      "failed-precondition",
      "첫 로그인 전 계정만 임시 비밀번호를 다시 발급할 수 있습니다.",
    );
  }

  const tempPassword = randomTempPassword();
  await admin.auth().updateUser(memberAuthUid, { password: tempPassword });
  await memberRef
    .collection("secrets")
    .doc("login")
    .set(await tempPasswordSecretFields(tempPassword), { merge: true });

  const attnId = memberSnap.get("attnId");
  const displayName = memberSnap.get("displayName");

  return {
    attnId: typeof attnId === "string" ? attnId : "",
    displayName: typeof displayName === "string" ? displayName : "",
    tempPassword,
    role,
  };
});

/**
 * 사용 중인 계정 비밀번호 초기화 — 비밀번호를 잊은 선생님·학부모 복구(로그인 ID 계정은 내부 이메일이라 재설정 메일 불가).
 * 새 임시 비밀번호를 발급하고(본인 비밀번호 해시 삭제) 첫 로그인 전(pending_setup)으로 되돌린 뒤 기존 세션을 끊는다.
 * 임시 비밀번호는 응답에서 한 번만 보여 준다. 연속 실패 잠금도 함께 푼다.
 */
export const resetMemberPassword = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const memberAuthUid =
    typeof request.data?.memberAuthUid === "string" ? request.data.memberAuthUid.trim() : "";
  const roleRaw = request.data?.role;
  if (
    !academyId ||
    !memberAuthUid ||
    memberAuthUid.includes("/") ||
    (roleRaw !== "teacher" && roleRaw !== "parent")
  ) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }
  const role: MemberKind = roleRaw;

  const db = admin.firestore();
  const actor = await assertPermission(
    db,
    academyId,
    uid,
    token,
    role === "teacher" ? "settings.members" : "operations.parents",
  );

  const memberRef = db.doc(`academies/${academyId}/${memberCollectionName(role)}/${memberAuthUid}`);
  const secretRef = memberRef.collection("secrets").doc("login");
  const [memberSnap, secretSnap] = await Promise.all([memberRef.get(), secretRef.get()]);
  if (!memberSnap.exists) {
    throw new HttpsError("not-found", "계정을 찾을 수 없습니다.");
  }
  const common = {
    status: memberSnap.get("status"),
    hasLoginPassword: hasLoginSecret(secretSnap.data()),
  };
  const staffTarget = {
    staffId: memberAuthUid,
    staffCurrentPermissions: normalizePermissionList(memberSnap.get("permissions")),
  };
  const violation = memberPasswordResetViolation(
    actor,
    role === "teacher" ? { kind: "teacher", ...common, ...staffTarget } : { kind: "parent", ...common },
  );
  if (violation) {
    throw new HttpsError("failed-precondition", violation);
  }

  const tempPassword = randomTempPassword();
  const batch = db.batch();
  batch.set(
    secretRef,
    {
      ...(await tempPasswordSecretFields(tempPassword)),
      ...loginThrottleFields(LOGIN_THROTTLE_RESET),
    },
    { merge: true },
  );
  batch.update(memberRef, {
    status: "pending_setup",
    passwordResetAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  await admin.auth().updateUser(memberAuthUid, { password: tempPassword });
  await admin.auth().setCustomUserClaims(memberAuthUid, {
    role,
    academyId,
    membershipStatus: "pending_setup",
  });
  await admin.auth().revokeRefreshTokens(memberAuthUid);

  const loginId = memberSnap.get("loginId");
  const attnId = memberSnap.get("attnId");
  const displayName = memberSnap.get("displayName");
  return {
    ok: true as const,
    role,
    loginId:
      typeof loginId === "string" && loginId ? loginId : typeof attnId === "string" ? attnId : "",
    displayName: typeof displayName === "string" ? displayName : "",
    tempPassword,
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
  await assertPermission(db, academyId, uid, token, "settings.members");

  const [teachersSnap, parentsSnap] = await Promise.all([
    db.collection(`academies/${academyId}/staff`).get(),
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
    // 계정 없는 직원(인사 정보만)은 발급 계정 목록에서 제외
    teachers: teachersSnap.docs
      .filter((d) => d.get("status") !== "no_account")
      .map((d) => mapRow(d, "teacher")),
    parents: parentsSnap.docs.map((d) => mapRow(d, "parent")),
  };
});
