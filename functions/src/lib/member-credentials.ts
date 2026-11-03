import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { attnLoginIndexPath } from "./attn-id";
import { allocateTeacherLoginId } from "./teacher-login-id";
import { tempPasswordSecretFields } from "./password-hash";
import { DEFAULT_STAFF_ROLE_ID } from "./permissions";

export type MemberKind = "teacher" | "parent";

export type MemberStatus = "pending_setup" | "active" | "inactive";

/** 멤버 문서 컬렉션 — 선생님(직원)은 `staff`, 학부모는 `parents` */
export function memberCollectionName(role: MemberKind): "staff" | "parents" {
  return role === "teacher" ? "staff" : "parents";
}

export type ProvisionedMember = {
  authUid: string;
  attnId: string;
  /** 선생님 로그인용 별칭 — attnLoginIndex 키 */
  loginId: string;
  displayName: string;
  tempPassword: string;
  role: MemberKind;
};

export function randomTempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 10; i++) {
    s += chars[crypto.randomInt(0, chars.length)]!;
  }
  return s + "1a!";
}

/**
 * 로그인 ID 계정(내부 이메일)의 Firebase Auth 비밀번호 — 아무도 모르는 무작위 값.
 * 앱 로그인은 서버가 `secrets/login` 해시로 확인한 뒤 커스텀 토큰을 주므로 Auth 비밀번호를 쓰지 않는다.
 * 사용자 비밀번호를 Auth에도 넣으면 내부 이메일로 `signInWithEmailAndPassword`를 시도해 연속 실패 잠금을 우회할 수 있음.
 * Auth 비밀번호를 만들거나 바꾸는 모든 곳(계정 생성·변경·재발급·초기화·seed)에서 이 값만 쓸 것.
 * (첫 로그인은 Auth 비밀번호를 바꾸지 않고 `revokeRefreshTokens`로 세션만 끊는다)
 */
export function randomAuthPassword(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** 로그인 ID 계정의 Auth 내부 이메일 — 사람이 쓰지 않는 주소(로그인은 로그인 ID로만) */
export function internalEmailForAttnId(attnId: string): string {
  const safe = attnId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `attn+${safe}@provision.attndot.internal`;
}

export async function provisionMemberAccount(params: {
  db: admin.firestore.Firestore;
  academyId: string;
  attnId: string;
  role: MemberKind;
  displayName: string;
  tempPassword?: string;
  /** 멤버 문서에 함께 쓸 필드(학부모 번호·승인 기록 등) */
  extra?: Record<string, unknown>;
}): Promise<ProvisionedMember> {
  const { db, academyId, attnId, role, displayName } = params;
  const tempPassword = params.tempPassword ?? randomTempPassword();
  const email = internalEmailForAttnId(attnId);

  const loginId =
    role === "teacher" ? await allocateTeacherLoginId(db) : attnId;

  const existingIndex = await db.doc(attnLoginIndexPath(loginId)).get();
  if (existingIndex.exists) {
    throw new Error("LOGIN_ID_EXISTS");
  }

  let userRecord: admin.auth.UserRecord;
  try {
    userRecord = await admin.auth().createUser({
      email,
      password: randomAuthPassword(),
      displayName,
      emailVerified: false,
      disabled: false,
    });
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === "auth/email-already-exists") {
      throw new Error("AUTH_EMAIL_COLLISION");
    }
    throw e;
  }

  const authUid = userRecord.uid;
  const col = role === "teacher" ? "staff" : "parents";
  const memberRef = db.doc(`academies/${academyId}/${col}/${authUid}`);

  const memberData: Record<string, unknown> = {
    attnId,
    displayName,
    email: "",
    academyId,
    status: "pending_setup" satisfies MemberStatus,
    authUid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (role === "teacher") {
    memberData.loginId = loginId;
    memberData.roleId = DEFAULT_STAFF_ROLE_ID;
    memberData.permissions = [];
    memberData.employmentStatus = "employed";
  }
  const batch = db.batch();
  batch.set(memberRef, { ...memberData, ...params.extra });
  batch.set(
    db.doc(`academies/${academyId}/${col}/${authUid}/secrets/login`),
    await tempPasswordSecretFields(tempPassword),
    { merge: true },
  );
  batch.set(db.doc(attnLoginIndexPath(loginId)), {
    loginId,
    attnId,
    academyId,
    authUid,
    role,
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  await admin.auth().setCustomUserClaims(authUid, {
    role,
    academyId,
    membershipStatus: "pending_setup",
  });

  return { authUid, attnId, loginId, displayName, tempPassword, role };
}
