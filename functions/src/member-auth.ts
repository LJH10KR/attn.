import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { attnLoginIndexPath, PARENT_ATTN_ID_RE, TEACHER_ATTN_ID_RE } from "./lib/attn-id";
import { normalizeMemberLoginId } from "./lib/member-login-id";
import { normalizeParentLoginId } from "./lib/parent-login-id";
import {
  memberCollectionName,
  randomAuthPassword,
  randomTempPassword,
  type MemberKind,
} from "./lib/member-credentials";
import { assertPermission } from "./lib/academy-access";
import {
  hasLoginSecret,
  passwordSecretFields,
  simulatePasswordCheck,
  tempPasswordSecretFields,
} from "./lib/password-hash";
import {
  LOGIN_THROTTLE_RESET,
  loginThrottleFields,
  verifyLoginPasswordThrottled,
} from "./lib/login-throttle";
import { normalizePermissionList } from "./lib/permissions";
import { parentStatusFromLinks, readLinkedStudentIdsInTx } from "./lib/parent-links";
import { memberPasswordResetViolation, staffAccountChangeViolation } from "./lib/role-policy";

/** 로그인 실패 응답 — 없는 ID·다른 역할의 ID·비밀번호 없음·틀린 비밀번호 모두 같은 코드·문구(계정 존재 여부를 알 수 없게) */
const LOGIN_FAILED_MSG = "로그인 ID 또는 비밀번호가 올바르지 않습니다.";

/** 연속 실패 제한(`login-throttle.ts`)을 거쳐 비밀번호 확인 후 멤버 상태 */
async function verifyMemberPassword(
  academyId: string,
  authUid: string,
  role: MemberKind,
  password: string,
  wrongMessage = LOGIN_FAILED_MSG,
): Promise<{ status: string; contactEmail?: string }> {
  const db = admin.firestore();
  await verifyLoginPasswordThrottled(
    db,
    db.doc(`academies/${academyId}/${memberCollectionName(role)}/${authUid}/secrets/login`),
    password,
    wrongMessage,
  );
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

/**
 * 로그인 ID 로그인용 커스텀 토큰. 커스텀 토큰에 넣은 클레임(developer claims)은 그 세션 내내 토큰 갱신 뒤에도 남아
 * `setCustomUserClaims`로 바꾼 값을 덮는다. 학부모는 세션 중 상태가 바뀌므로(이메일 인증 → 승인 대기, 연결 → 사용 중)
 * 토큰에 클레임을 넣지 않고 서버에 저장된 클레임(직전에 `setCustomUserClaims`)만 따르게 한다. 직원 흐름은 그대로.
 */
function createMemberCustomToken(
  uid: string,
  role: MemberKind,
  academyId: string,
  status: string,
): Promise<string> {
  if (role === "parent") return admin.auth().createCustomToken(uid);
  return admin.auth().createCustomToken(uid, { role, academyId, membershipStatus: status });
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
  const academyId = indexSnap?.get("academyId");
  const authUid = indexSnap?.get("authUid");
  if (
    !indexSnap?.exists ||
    typeof academyId !== "string" ||
    typeof authUid !== "string" ||
    indexSnap.get("role") !== role
  ) {
    // 실제 계정과 같은 비용의 검증을 거친 뒤 같은 응답
    await simulatePasswordCheck(password);
    throw new HttpsError("permission-denied", LOGIN_FAILED_MSG);
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

  const customToken = await createMemberCustomToken(authUid, role, academyId, status);

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

/**
 * 로그인 중인 선생님·학부모 본인 재확인 — Google 계정 연결처럼 "최근 로그인"이 필요한 작업 전.
 * Auth 비밀번호는 무작위 값이라 클라이언트 `reauthenticateWithCredential`을 쓸 수 없으므로
 * 서버가 로그인 ID 비밀번호를 확인(로그인과 같은 연속 실패 잠금)하고 새 커스텀 토큰을 준다 — 그 토큰으로 다시 로그인하면 최근 로그인이 됨.
 */
export const reauthenticateMember = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid, token } = request.auth;
  const role = token.role === "parent" ? "parent" : token.role === "teacher" ? "teacher" : null;
  const academyId = typeof token.academyId === "string" ? token.academyId : "";
  if (!role || !academyId) {
    throw new HttpsError("failed-precondition", "선생님 또는 학부모 계정만 처리할 수 있습니다.");
  }
  const password = typeof request.data?.password === "string" ? request.data.password : "";
  if (!password) {
    throw new HttpsError("invalid-argument", "비밀번호를 입력해 주세요.");
  }
  const { status } = await verifyMemberPassword(
    academyId,
    uid,
    role,
    password,
    "비밀번호가 올바르지 않습니다.",
  );
  const customToken = await createMemberCustomToken(uid, role, academyId, status);
  return { ok: true as const, customToken };
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

/**
 * 최초 비밀번호 변경 + 사용 가능 상태로(직원 active, 학부모는 연결 수로).
 * 임시 비밀번호로 만들어진 다른 기기 세션은 모두 끊고(`revokeRefreshTokens`), 지금 기기는 응답의 새 커스텀 토큰으로
 * 다시 로그인한다 — 끊기 전 발급된 이 기기의 토큰도 갱신이 거부되므로(첫 로그인 직후 새로고침에서 로그아웃되던 문제).
 * 순서: 해시 저장(임시 비밀번호 무효) → 세션 끊기 → 상태 전환 → 클레임 → 새 토큰(전환 뒤 상태).
 * 세션 끊기를 상태 전환보다 먼저 하는 이유: 전환 뒤에 끊기가 실패하면 다시 호출할 수 없어(이미 active) 다른 세션이 남는다.
 */
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
  // 학원이 직접 만들어 준 계정의 첫 로그인만 — 승인 대기(가입 링크 가입)·비활성 계정이 스스로 활성화하지 못하게
  if (memberSnap.get("status") !== "pending_setup") {
    throw new HttpsError("failed-precondition", "첫 로그인 비밀번호 설정이 필요한 계정이 아닙니다.");
  }

  await memberRef
    .collection("secrets")
    .doc("login")
    .set(await passwordSecretFields(newPassword), { merge: true });
  // 임시 비밀번호로 만든 세션(다른 기기 포함)을 모두 끊는다 — 지금 기기는 아래 새 토큰으로 다시 로그인
  await admin.auth().revokeRefreshTokens(uid);
  // 직원은 사용 중, 학부모는 연결 수로(0명이면 연결 대기)
  const db = admin.firestore();
  const membershipStatus = await db.runTransaction(async (tx) => {
    const snap = await tx.get(memberRef);
    if (snap.get("status") !== "pending_setup") {
      throw new HttpsError("failed-precondition", "첫 로그인 비밀번호 설정이 필요한 계정이 아닙니다.");
    }
    const linkedStudentIds =
      role === "parent" ? await readLinkedStudentIdsInTx(tx, db, academyId, uid) : null;
    const next = linkedStudentIds ? parentStatusFromLinks(linkedStudentIds.length) : "active";
    tx.update(memberRef, {
      status: next,
      ...(linkedStudentIds ? { linkedStudentIds } : {}),
      ...(next === "active" ? { activatedAt: FieldValue.serverTimestamp() } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return next;
  });

  await admin.auth().setCustomUserClaims(uid, {
    role,
    academyId,
    membershipStatus,
  });

  // 끊은 뒤 발급 — 직원 토큰의 클레임은 전환 뒤 상태(세션 내내 남으므로 pending_setup이면 안 됨)
  const customToken = await createMemberCustomToken(uid, role, academyId, membershipStatus);
  return { ok: true, membershipStatus, customToken };
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
  await admin.auth().updateUser(memberAuthUid, { password: randomAuthPassword() });
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

  await admin.auth().updateUser(memberAuthUid, { password: randomAuthPassword() });
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
