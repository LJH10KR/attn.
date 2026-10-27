import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp, type DocumentReference } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getAppOrigin } from "./auth-short-links";
import { assertPermission, type AcademyActor } from "./lib/academy-access";
import { assertMemberLoginIdAvailable } from "./lib/member-login-id";
import { DEFAULT_STAFF_ROLE_ID } from "./lib/permissions";
import { roleAssignViolation } from "./lib/role-policy";
import {
  loadRolePermissions,
  provisionStaffAccount,
  type ProvisionedStaffAccount,
} from "./lib/staff-account";

/**
 * 직원 초대(설정 › 멤버 초대) — 이메일 초청 대신 두 가지.
 * 1) 초대 링크: 직원 한 명에게 묶인 1회용 링크(72시간). 받은 사람이 로그인 ID·비밀번호 또는 Google로 가입하면
 *    "등록 대기"가 되고 원장(멤버 관리 권한)이 승인해야 활성(링크가 다른 사람에게 넘어가도 권한이 바로 생기지 않게).
 * 2) 직접 만들어 주기: 자동 로그인 ID + 임시 비밀번호를 바로 발급(최초 로그인 시 비밀번호 변경 후 활성).
 *
 * 초대 문서는 `staffInvites/{sha256(token)}` — 토큰 원문은 저장하지 않는다(클라이언트 접근 불가, 규칙 기본 거부).
 */

const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_ACCOUNTS_PER_REQUEST = 10;
const MAX_NAME_LENGTH = 60;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function inviteRef(db: admin.firestore.Firestore, tokenHash: string) {
  return db.doc(`staffInvites/${tokenHash}`);
}

function requireString(raw: unknown, message: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.includes("/")) {
    throw new HttpsError("invalid-argument", message);
  }
  return s;
}

function parseToken(raw: unknown): string {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) {
    throw new HttpsError("invalid-argument", "초대 링크가 올바르지 않습니다.");
  }
  return token;
}

/** 지금 초대·계정 발급이 가능한 직원 문서 — 없으면 이름으로 새 직원(계정 없음)을 만든다 */
async function resolveInviteTarget(
  db: admin.firestore.Firestore,
  academyId: string,
  raw: { staffId?: unknown; displayName?: unknown },
): Promise<{ ref: DocumentReference; displayName: string; inviteTokenHash: string | null }> {
  const staffId = typeof raw.staffId === "string" ? raw.staffId.trim() : "";
  if (staffId) {
    const ref = db.doc(`academies/${academyId}/staff/${requireString(staffId, "직원 정보가 올바르지 않습니다.")}`);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError("not-found", "직원 정보를 찾을 수 없습니다.");
    }
    if (snap.get("status") !== "no_account" || snap.get("isGuest") === true) {
      throw new HttpsError("failed-precondition", "이미 계정이 있는 직원입니다.");
    }
    if (snap.get("employmentStatus") === "resigned") {
      throw new HttpsError("failed-precondition", "퇴사 처리된 직원은 초대할 수 없습니다.");
    }
    const hash = snap.get("inviteTokenHash");
    return {
      ref,
      displayName: typeof snap.get("displayName") === "string" ? snap.get("displayName") : "",
      inviteTokenHash: typeof hash === "string" && hash ? hash : null,
    };
  }

  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  if (!displayName || displayName.length > MAX_NAME_LENGTH) {
    throw new HttpsError("invalid-argument", `이름을 1~${MAX_NAME_LENGTH}자로 입력해 주세요.`);
  }
  const ref = db.collection(`academies/${academyId}/staff`).doc();
  await ref.set({
    displayName,
    phone: null,
    jobTitleId: null,
    hireDate: null,
    employmentStatus: "employed",
    memo: "",
    academyId,
    status: "no_account",
    authUid: null,
    isGuest: false,
    roleId: DEFAULT_STAFF_ROLE_ID,
    permissions: [],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ref, displayName, inviteTokenHash: null };
}

/** 부여할 역할 — 존재해야 하고, 직원은 본인 권한을 넘는 역할을 줄 수 없음 */
async function resolveGrantableRole(
  db: admin.firestore.Firestore,
  academyId: string,
  actor: AcademyActor,
  rawRoleId: unknown,
) {
  const roleId = requireString(rawRoleId ?? DEFAULT_STAFF_ROLE_ID, "권한을 선택해 주세요.");
  const permissions = await loadRolePermissions(db, academyId, roleId);
  if (!permissions) {
    throw new HttpsError("not-found", "권한을 찾을 수 없습니다.");
  }
  const violation = roleAssignViolation(actor, {
    staffId: "",
    staffCurrentPermissions: [],
    rolePermissions: permissions,
  });
  if (violation) {
    throw new HttpsError("permission-denied", violation);
  }
  return { roleId, permissions };
}

/** 직원 문서에 걸린 초대를 지움 — 새 링크 발급·계정 직접 발급·퇴사·삭제 시 */
export async function clearStaffInvite(
  db: admin.firestore.Firestore,
  staffRef: DocumentReference,
  tokenHash: string | null,
): Promise<void> {
  if (tokenHash) {
    await inviteRef(db, tokenHash).delete();
  }
  const snap = await staffRef.get();
  if (snap.exists) {
    await staffRef.update({
      inviteTokenHash: FieldValue.delete(),
      inviteRoleId: FieldValue.delete(),
      inviteExpiresAt: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
}

/** 초대 링크 만들기 — 같은 직원의 이전 링크는 무효 */
export const createStaffInvite = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireString(request.data?.academyId, "학원 ID가 필요합니다.");
  const db = admin.firestore();
  const actor = await assertPermission(
    db,
    academyId,
    request.auth.uid,
    request.auth.token,
    "settings.members",
  );
  const role = await resolveGrantableRole(db, academyId, actor, request.data?.roleId);
  const target = await resolveInviteTarget(db, academyId, request.data ?? {});

  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = Timestamp.fromMillis(Date.now() + INVITE_TTL_MS);

  if (target.inviteTokenHash) {
    await inviteRef(db, target.inviteTokenHash).delete();
  }
  const batch = db.batch();
  batch.set(inviteRef(db, tokenHash), {
    academyId,
    staffId: target.ref.id,
    roleId: role.roleId,
    createdByUid: request.auth.uid,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
  });
  batch.update(target.ref, {
    inviteTokenHash: tokenHash,
    inviteRoleId: role.roleId,
    inviteExpiresAt: expiresAt,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  return {
    ok: true as const,
    staffId: target.ref.id,
    url: `${getAppOrigin()}/join/staff?token=${token}`,
    expiresAtMillis: expiresAt.toMillis(),
  };
});

export const cancelStaffInvite = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireString(request.data?.academyId, "학원 ID가 필요합니다.");
  const staffId = requireString(request.data?.staffId, "직원 정보가 올바르지 않습니다.");
  const db = admin.firestore();
  await assertPermission(db, academyId, request.auth.uid, request.auth.token, "settings.members");

  const ref = db.doc(`academies/${academyId}/staff/${staffId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "직원 정보를 찾을 수 없습니다.");
  }
  const hash = snap.get("inviteTokenHash");
  await clearStaffInvite(db, ref, typeof hash === "string" && hash ? hash : null);
  return { ok: true as const };
});

/** 계정 직접 만들어 주기 — 최대 10명, 임시 비밀번호는 응답에서 한 번만 보여 줌 */
export const createStaffAccounts = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireString(request.data?.academyId, "학원 ID가 필요합니다.");
  const items = request.data?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpsError("invalid-argument", "계정을 만들 직원을 선택해 주세요.");
  }
  if (items.length > MAX_ACCOUNTS_PER_REQUEST) {
    throw new HttpsError(
      "invalid-argument",
      `한 번에 최대 ${MAX_ACCOUNTS_PER_REQUEST}명까지 만들 수 있습니다.`,
    );
  }

  const db = admin.firestore();
  const actor = await assertPermission(
    db,
    academyId,
    request.auth.uid,
    request.auth.token,
    "settings.members",
  );

  const accounts: Array<ProvisionedStaffAccount & { staffId: string }> = [];
  for (const raw of items as Array<Record<string, unknown>>) {
    const role = await resolveGrantableRole(db, academyId, actor, raw?.roleId);
    const target = await resolveInviteTarget(db, academyId, raw ?? {});
    if (target.inviteTokenHash) {
      await clearStaffInvite(db, target.ref, target.inviteTokenHash);
    }
    const account = await provisionStaffAccount({
      db,
      academyId,
      hrRef: target.ref,
      displayName: target.displayName,
      roleId: role.roleId,
      permissions: role.permissions,
      mode: { kind: "temp" },
      status: "pending_setup",
    });
    accounts.push({ ...account, staffId: account.authUid });
  }
  return { ok: true as const, accounts };
});

/** 초대 문서·직원 문서가 아직 유효한지 — 유효하면 학원·직원·역할 정보 */
async function loadValidInvite(db: admin.firestore.Firestore, tokenHash: string) {
  const snap = await inviteRef(db, tokenHash).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "이미 사용했거나 취소된 초대 링크입니다. 학원에 새 링크를 요청해 주세요.");
  }
  const expiresAt = snap.get("expiresAt") as Timestamp | undefined;
  if (!expiresAt || expiresAt.toMillis() < Date.now()) {
    throw new HttpsError("deadline-exceeded", "초대 링크 유효 기간(72시간)이 지났습니다. 학원에 새 링크를 요청해 주세요.");
  }
  const academyId = snap.get("academyId") as string;
  const staffId = snap.get("staffId") as string;
  const roleId = snap.get("roleId") as string;
  const [academySnap, staffSnap, roleSnap] = await Promise.all([
    db.doc(`academies/${academyId}`).get(),
    db.doc(`academies/${academyId}/staff/${staffId}`).get(),
    db.doc(`academies/${academyId}/roles/${roleId}`).get(),
  ]);
  if (
    !academySnap.exists ||
    !staffSnap.exists ||
    staffSnap.get("status") !== "no_account" ||
    staffSnap.get("inviteTokenHash") !== tokenHash
  ) {
    throw new HttpsError("not-found", "이미 사용했거나 취소된 초대 링크입니다. 학원에 새 링크를 요청해 주세요.");
  }
  return { snap, academySnap, staffSnap, roleSnap, academyId, staffId, roleId };
}

/** 공개 — 초대 링크 화면에 보여 줄 학원·이름·권한 */
export const getStaffInviteInfo = onCall(async (request) => {
  const tokenHash = hashToken(parseToken(request.data?.token));
  const db = admin.firestore();
  const { academySnap, staffSnap, roleSnap, snap } = await loadValidInvite(db, tokenHash);
  return {
    ok: true as const,
    academyName: typeof academySnap.get("name") === "string" ? academySnap.get("name") : "학원",
    displayName: typeof staffSnap.get("displayName") === "string" ? staffSnap.get("displayName") : "",
    roleName: roleSnap.exists && typeof roleSnap.get("name") === "string" ? roleSnap.get("name") : "선생님",
    expiresAtMillis: (snap.get("expiresAt") as Timestamp).toMillis(),
  };
});

/** 공개 — 초대 링크 화면의 로그인 ID 중복 확인(유효한 초대가 있을 때만, 무작위 조회 방지) */
export const checkStaffInviteLoginId = onCall(async (request) => {
  const tokenHash = hashToken(parseToken(request.data?.token));
  const raw = typeof request.data?.loginId === "string" ? request.data.loginId : "";
  if (!raw.trim()) {
    throw new HttpsError("invalid-argument", "로그인 ID를 입력해 주세요.");
  }
  const db = admin.firestore();
  await loadValidInvite(db, tokenHash);
  const loginId = await assertMemberLoginIdAvailable(db, raw);
  return { ok: true as const, available: true as const, loginId };
});

/**
 * 초대 수락 — method "password"(공개: 로그인 ID·비밀번호) 또는 "google"(Google 로그인 상태).
 * 결과는 항상 "등록 대기" — 원장 승인(`activateTeacher`) 후 이용 가능.
 */
export const acceptStaffInvite = onCall(async (request) => {
  const tokenHash = hashToken(parseToken(request.data?.token));
  const method = request.data?.method;
  if (method !== "password" && method !== "google") {
    throw new HttpsError("invalid-argument", "가입 방법을 선택해 주세요.");
  }

  const db = admin.firestore();
  const invite = await loadValidInvite(db, tokenHash);

  let mode:
    | { kind: "password"; loginId: string; password: string }
    | { kind: "google"; uid: string; email: string };
  if (method === "password") {
    const loginId = typeof request.data?.loginId === "string" ? request.data.loginId : "";
    const password = typeof request.data?.password === "string" ? request.data.password : "";
    if (!loginId.trim()) {
      throw new HttpsError("invalid-argument", "로그인 ID를 입력해 주세요.");
    }
    if (password.length < 6) {
      throw new HttpsError("invalid-argument", "비밀번호는 6자 이상이어야 합니다.");
    }
    mode = { kind: "password", loginId, password };
  } else {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Google 로그인 후 다시 시도해 주세요.");
    }
    const user = await admin.auth().getUser(uid);
    const google = user.providerData.find((p) => p.providerId === "google.com");
    if (!google) {
      throw new HttpsError("failed-precondition", "Google 로그인 후 다시 시도해 주세요.");
    }
    const [ownerProfile, existing] = await Promise.all([
      db.doc(`users/${uid}`).get(),
      db.doc(`academies/${invite.academyId}/staff/${uid}`).get(),
    ]);
    if (invite.academySnap.get("ownerUid") === uid || ownerProfile.get("platformRole") === "owner") {
      throw new HttpsError(
        "failed-precondition",
        "원장 계정으로는 직원으로 가입할 수 없습니다. 다른 Google 계정을 사용해 주세요.",
      );
    }
    if (existing.exists) {
      throw new HttpsError("already-exists", "이미 이 학원에 가입된 계정입니다. 로그인해 주세요.");
    }
    mode = { kind: "google", uid, email: google.email ?? user.email ?? "" };
  }

  // 같은 링크로 동시에 가입하지 못하도록 초대 문서를 먼저 회수(실패하면 되돌림)
  const claimed = await db.runTransaction(async (tx) => {
    const ref = inviteRef(db, tokenHash);
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    tx.delete(ref);
    return snap.data()!;
  });
  if (!claimed) {
    throw new HttpsError("not-found", "이미 사용했거나 취소된 초대 링크입니다. 학원에 새 링크를 요청해 주세요.");
  }

  const permissions = (await loadRolePermissions(db, invite.academyId, invite.roleId)) ?? [];
  try {
    const account = await provisionStaffAccount({
      db,
      academyId: invite.academyId,
      hrRef: invite.staffSnap.ref,
      displayName:
        typeof invite.staffSnap.get("displayName") === "string"
          ? invite.staffSnap.get("displayName")
          : "",
      // 초대 뒤 역할이 지워졌으면 기본 역할(권한 없음)
      roleId: invite.roleSnap.exists ? invite.roleId : DEFAULT_STAFF_ROLE_ID,
      permissions,
      mode,
      status: "pending_registration",
    });
    return {
      ok: true as const,
      membershipStatus: "pending_registration" as const,
      loginId: account.loginId,
    };
  } catch (e) {
    await inviteRef(db, tokenHash).set(claimed);
    throw e;
  }
});
