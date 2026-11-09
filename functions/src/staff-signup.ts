import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { assertPermission } from "./lib/academy-access";
import { assertFreshAppCheck, ONE_SHOT_APP_CHECK_OPTIONS, SIGNUP_APP_CHECK_OPTIONS } from "./lib/app-check";
import { assertKrPhoneRequired } from "./lib/kr-phone";
import { parseRequiredConsents } from "./lib/legal-docs";
import { assertPhoneProofUsable, readOptionalPhoneProof, signupProofExpectation } from "./lib/phone-proof";
import { readPhoneProofInTx, verifiedPhoneFields, type PhoneProofExpectation } from "./lib/phone-verification";
import { assertMemberLoginIdAvailable } from "./lib/member-login-id";
import { DEFAULT_STAFF_ROLE_ID } from "./lib/permissions";
import { consumeSignupQuota, resolveSignupLink } from "./lib/signup-links";
import { loadRolePermissions, provisionStaffAccount, type StaffAccountMode } from "./lib/staff-account";
import { findStaffSignupMatches, mergeStaffSignupIntoRecord } from "./lib/staff-signup-merge";
import { writeInfoBell } from "./lib/admin-inbox-info";
import * as logger from "firebase-functions/logger";
import { resolveGrantableRole } from "./staff-accounts";

/**
 * 공용 직원 가입 링크(2-K, `/join/staff?token=…`) — 학원마다 1개, 1인 초대 링크(폐지)를 대신한다.
 * 가입하면 "가입 승인 대기"(기본 역할, 권한 없음)이고 원장(멤버 관리 권한)이 승인해야 이용할 수 있다.
 * 원장이 계정 없는 직원에 번호·"가입하면 줄 권한"을 미리 등록해 두면, 승인 화면에서 같은 번호의 후보로 보고
 * [이 직원으로 승인](인사 정보·역할을 합치고 활성)할 수 있다.
 * 2-L: 휴대폰 번호가 문자로 확인되고 후보가 정확히 1명 + 역할 명시면 서버가 바로 합쳐 활성(`tryAutoActivateStaff`) —
 * 번호 확인 없이 번호만으로는 자동으로 합치거나 활성하지 않는다.
 */

const MAX_NAME_LENGTH = 60;

function requireString(raw: unknown, message: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.includes("/")) {
    throw new HttpsError("invalid-argument", message);
  }
  return s;
}

/** 공개 — 가입 QR 토큰으로 학원 이름(가입 폼을 보여 주기 전) */
export const getStaffSignupInfo = onCall(async (request) => {
  const link = await resolveSignupLink(admin.firestore(), request.data?.token, "staff");
  return { ok: true as const, academyName: link.academyName };
});

/** 공개 — 로그인 ID 중복 확인(유효한 직원 가입 링크가 있을 때만) */
export const checkStaffSignupLoginId = onCall(SIGNUP_APP_CHECK_OPTIONS, async (request) => {
  const raw = typeof request.data?.loginId === "string" ? request.data.loginId : "";
  if (!raw.trim()) {
    throw new HttpsError("invalid-argument", "로그인 ID를 입력해 주세요.");
  }
  const db = admin.firestore();
  await resolveSignupLink(db, request.data?.token, "staff");
  const loginId = await assertMemberLoginIdAvailable(db, raw);
  return { ok: true as const, available: true as const, loginId };
});

/**
 * 공용 링크로 직원 가입 — method "password"(공개: 로그인 ID·비밀번호) 또는 "google"(Google 로그인 상태).
 * 이름·휴대폰 번호 필수. 결과는 항상 "가입 승인 대기"(기본 역할).
 */
export const registerStaffSignup = onCall(ONE_SHOT_APP_CHECK_OPTIONS, async (request) => {
  assertFreshAppCheck(request);
  const method = request.data?.method;
  if (method !== "password" && method !== "google") {
    throw new HttpsError("invalid-argument", "가입 방법을 선택해 주세요.");
  }
  const db = admin.firestore();
  const link = await resolveSignupLink(db, request.data?.token, "staff");

  const displayName = typeof request.data?.displayName === "string" ? request.data.displayName.trim() : "";
  if (!displayName || displayName.length > MAX_NAME_LENGTH) {
    throw new HttpsError("invalid-argument", `이름을 1~${MAX_NAME_LENGTH}자로 입력해 주세요.`);
  }
  const phone = assertKrPhoneRequired(request.data?.phone);
  const consents = parseRequiredConsents(request.data?.consents);
  const phoneProof = readOptionalPhoneProof(request.data?.phoneProof);
  const proofExpect: PhoneProofExpectation | null = phoneProof
    ? signupProofExpectation(request.data?.token, "staff_signup", phone)
    : null;

  let mode: StaffAccountMode;
  if (method === "password") {
    const loginId = typeof request.data?.loginId === "string" ? request.data.loginId : "";
    const password = typeof request.data?.password === "string" ? request.data.password : "";
    if (!loginId.trim()) {
      throw new HttpsError("invalid-argument", "로그인 ID를 입력해 주세요.");
    }
    if (password.length < 6) {
      throw new HttpsError("invalid-argument", "비밀번호는 6자 이상이어야 합니다.");
    }
    await assertMemberLoginIdAvailable(db, loginId);
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
      db.doc(`academies/${link.academyId}/staff/${uid}`).get(),
    ]);
    if (link.academySnap.get("ownerUid") === uid || ownerProfile.get("platformRole") === "owner") {
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

  if (phoneProof && proofExpect) await assertPhoneProofUsable(db, phoneProof, proofExpect);

  // 입력·중복 검사를 모두 통과한 뒤 계정을 만들기 직전에 한 건을 센다(링크별 시간당 한도)
  const { academyId } = await consumeSignupQuota(db, request.data?.token, "staff");

  let phoneVerified = false;
  const account = await provisionStaffAccount({
    db,
    academyId,
    hrRef: null,
    displayName,
    roleId: DEFAULT_STAFF_ROLE_ID,
    permissions: (await loadRolePermissions(db, academyId, DEFAULT_STAFF_ROLE_ID)) ?? [],
    mode,
    status: "pending_registration",
    signup: { phone, signupSource: "staff_link" },
    // 번호 확인 증표 소비·동의 기록을 계정 쓰기와 같은 트랜잭션에서
    inTx: async (tx, authUid) => {
      const proof = phoneProof && proofExpect ? await readPhoneProofInTx(tx, db, phoneProof, proofExpect) : null;
      phoneVerified = proof !== null;
      return {
        fields: { consents, ...(proof ? verifiedPhoneFields(proof.phoneKey) : {}) },
        write: () => proof?.markUsed(authUid),
      };
    },
  });
  const activated = phoneVerified ? await tryAutoActivateStaff(db, academyId, account.authUid, phone) : null;
  return {
    ok: true as const,
    membershipStatus: activated ? ("active" as const) : ("pending_registration" as const),
    loginId: account.loginId,
    phoneVerified,
  };
});

export function staffAutoActivatedBellId(accountUid: string): string {
  return `s-autoact-${accountUid}`;
}

/**
 * 직원 자동 활성(2-L, 2-K 넘긴 일) — 번호가 문자로 확인됐고, 미리 등록한 직원 후보(계정 없음·퇴사 아님·게스트 아님·같은 번호)가
 * **정확히 1명**이며 그 후보에 "가입하면 줄 권한"(`signupRoleId`, 지금 있는 역할)이 명시돼 있으면 서버가 바로 합쳐 활성(actor null).
 * 그 밖(후보 0명·2명 이상·역할 없음·역할이 지워짐·합치기 실패)은 지금처럼 승인 대기(승인 화면 후보 표시). 원장 벨 1건.
 */
async function tryAutoActivateStaff(
  db: admin.firestore.Firestore,
  academyId: string,
  accountUid: string,
  phone: string,
): Promise<{ roleId: string } | null> {
  try {
    const matches = await findStaffSignupMatches(db, academyId, phone);
    if (matches.length !== 1) return null;
    const hr = matches[0]!;
    const roleId = hr.get("signupRoleId");
    if (typeof roleId !== "string" || !roleId) return null;
    const role = await db.doc(`academies/${academyId}/roles/${roleId}`).get();
    if (!role.exists) return null;
    const result = await mergeStaffSignupIntoRecord(db, { academyId, accountUid, hrStaffId: hr.id, actor: null });
    const account = await db.doc(`academies/${academyId}/staff/${accountUid}`).get();
    const name = typeof account.get("displayName") === "string" ? account.get("displayName") : "";
    await writeInfoBell(db, academyId, staffAutoActivatedBellId(accountUid), {
      kind: "staff_auto_activated",
      entityType: "teacher",
      entityId: accountUid,
      displayName: name || "이름 미입력",
      roleId: result.roleId,
      roleName: typeof role.get("name") === "string" ? role.get("name") : "",
    });
    return { roleId: result.roleId };
  } catch (e) {
    logger.warn("registerStaffSignup: 자동 활성 안 됨(승인 대기로 둠)", { academyId, accountUid, e });
    return null;
  }
}

/**
 * 미리 등록 — 계정 없는 직원에 "가입하면 줄 권한"을 적어 둠(번호는 직원 관리 인사 정보).
 * `roleId: null`이면 해제. 직원은 본인 권한을 넘는 역할을 정할 수 없다.
 */
export const setStaffSignupRole = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireString(request.data?.academyId, "학원 ID가 필요합니다.");
  const staffId = requireString(request.data?.staffId, "직원 정보가 올바르지 않습니다.");
  const db = admin.firestore();
  const actor = await assertPermission(db, academyId, request.auth.uid, request.auth.token, "settings.members");

  const ref = db.doc(`academies/${academyId}/staff/${staffId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "직원 정보를 찾을 수 없습니다.");
  }
  if (snap.get("status") !== "no_account" || snap.get("isGuest") === true) {
    throw new HttpsError("failed-precondition", "이미 계정이 있는 직원입니다.");
  }
  if (snap.get("employmentStatus") === "resigned") {
    throw new HttpsError("failed-precondition", "퇴사 처리된 직원은 미리 등록할 수 없습니다.");
  }

  const rawRoleId = request.data?.roleId;
  if (rawRoleId === null) {
    await ref.update({
      signupRoleId: FieldValue.delete(),
      signupRoleSetByUid: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ok: true as const, roleId: null };
  }
  const role = await resolveGrantableRole(db, academyId, actor, rawRoleId);
  await ref.update({
    signupRoleId: role.roleId,
    signupRoleSetByUid: request.auth.uid,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true as const, roleId: role.roleId };
});

/** 승인 화면 [이 직원으로 승인] — 미리 등록한 직원(같은 번호)의 인사 정보·역할을 합치고 활성 */
export const approveStaffSignupAsExisting = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireString(request.data?.academyId, "학원 ID가 필요합니다.");
  const accountUid = requireString(request.data?.staffAuthUid, "요청이 올바르지 않습니다.");
  const hrStaffId = requireString(request.data?.hrStaffId, "요청이 올바르지 않습니다.");
  const db = admin.firestore();
  const actor = await assertPermission(db, academyId, request.auth.uid, request.auth.token, "settings.members");
  const result = await mergeStaffSignupIntoRecord(db, { academyId, accountUid, hrStaffId, actor });
  return { ok: true as const, roleId: result.roleId };
});
