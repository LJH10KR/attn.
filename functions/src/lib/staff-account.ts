import * as admin from "firebase-admin";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { academySeqMetaPath, attnLoginIndexPath, formatTeacherAttnId } from "./attn-id";
import { randomAuthPassword, randomTempPassword } from "./member-credentials";
import { assertMemberLoginIdAvailable } from "./member-login-id";
import { passwordSecretFields, tempPasswordSecretFields } from "./password-hash";
import { DEFAULT_STAFF_ROLE_ID, normalizePermissionList, type AcademyPermission } from "./permissions";
import { allocateTeacherLoginId } from "./teacher-login-id";

/**
 * 직원 계정 만들기 — 초대 링크 가입(`staff-invites.ts`)과 직접 만들어 주기(`createStaffAccounts`) 공용.
 * 계정 없는 직원 문서(인사 정보)가 있으면 그 내용을 `staff/{authUid}`로 옮기고 원래 문서를 지운다.
 */

/** 인사 정보 중 계정 문서로 옮기는 필드 — 계정·권한 필드는 새로 씀 */
const HR_FIELDS = [
  "displayName",
  "phone",
  "jobTitleId",
  "hireDate",
  "employmentStatus",
  "memo",
  "createdAt",
] as const;

export type StaffAccountMode =
  /** 학원이 직접 만들어 줌 — 자동 로그인 ID + 임시 비밀번호, 최초 로그인 시 비밀번호 변경 */
  | { kind: "temp" }
  /** 초대받은 사람이 로그인 ID·비밀번호를 직접 정함 */
  | { kind: "password"; loginId: string; password: string }
  /** 초대받은 사람이 Google 계정으로 가입(이미 로그인된 uid) */
  | { kind: "google"; uid: string; email: string };

export type ProvisionedStaffAccount = {
  authUid: string;
  attnId: string;
  loginId: string;
  displayName: string;
  /** kind "temp"일 때만 — 한 번만 보여 줌 */
  tempPassword?: string;
};

function internalEmailForAttnId(attnId: string): string {
  const safe = attnId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `attn+${safe}@provision.attndot.internal`;
}

async function allocateTeacherAttnId(
  db: admin.firestore.Firestore,
  academyId: string,
): Promise<string> {
  return db.runTransaction(async (tx) => {
    const seqRef = db.doc(academySeqMetaPath(academyId));
    const seqSnap = await tx.get(seqRef);
    const next = (seqSnap.get("nextTeacherSeq") as number) || 1;
    tx.set(seqRef, { nextTeacherSeq: next + 1 }, { merge: true });
    return formatTeacherAttnId(academyId, next);
  });
}

/** 역할의 현재 권한 — 역할이 지워졌으면 null */
export async function loadRolePermissions(
  db: admin.firestore.Firestore,
  academyId: string,
  roleId: string,
): Promise<AcademyPermission[] | null> {
  const snap = await db.doc(`academies/${academyId}/roles/${roleId}`).get();
  return snap.exists ? normalizePermissionList(snap.get("permissions")) : null;
}

export async function provisionStaffAccount(params: {
  db: admin.firestore.Firestore;
  academyId: string;
  /** 계정 없는 직원 문서 — 없으면 이름만으로 새 직원 */
  hrRef: DocumentReference | null;
  displayName: string;
  roleId: string;
  permissions: AcademyPermission[];
  mode: StaffAccountMode;
  status: "pending_setup" | "pending_registration";
}): Promise<ProvisionedStaffAccount> {
  const { db, academyId, hrRef, displayName, roleId, permissions, mode, status } = params;

  const loginId =
    mode.kind === "temp"
      ? await allocateTeacherLoginId(db)
      : mode.kind === "password"
        ? await assertMemberLoginIdAvailable(db, mode.loginId)
        : "";
  const attnId = await allocateTeacherAttnId(db, academyId);
  const tempPassword = mode.kind === "temp" ? randomTempPassword() : undefined;

  let authUid: string;
  let createdAuthUser = false;
  if (mode.kind === "google") {
    authUid = mode.uid;
  } else {
    try {
      const user = await admin.auth().createUser({
        email: internalEmailForAttnId(attnId),
        password: randomAuthPassword(),
        displayName,
        emailVerified: false,
        disabled: false,
      });
      authUid = user.uid;
      createdAuthUser = true;
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "auth/email-already-exists") {
        throw new HttpsError("aborted", "계정을 만드는 중 충돌이 생겼습니다. 다시 시도해 주세요.");
      }
      throw e;
    }
  }

  try {
    const hrSnap = hrRef ? await hrRef.get() : null;
    const hr: Record<string, unknown> = {};
    if (hrSnap?.exists) {
      for (const k of HR_FIELDS) {
        const v = hrSnap.get(k);
        if (v !== undefined) hr[k] = v;
      }
    }

    const memberRef = db.doc(`academies/${academyId}/staff/${authUid}`);
    const batch = db.batch();
    batch.set(memberRef, {
      employmentStatus: "employed",
      createdAt: FieldValue.serverTimestamp(),
      ...hr,
      displayName,
      attnId,
      ...(loginId ? { loginId } : {}),
      email: mode.kind === "google" ? mode.email : "",
      academyId,
      status,
      authUid,
      isGuest: false,
      roleId,
      permissions,
      authProvider: mode.kind === "google" ? "google" : "password",
      ...(mode.kind === "google" ? { googleLinked: true, googleEmail: mode.email } : {}),
      ...(status === "pending_registration"
        ? { onboardingCompleteAt: FieldValue.serverTimestamp() }
        : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    batch.set(
      memberRef.collection("secrets").doc("login"),
      {
        ...(mode.kind === "temp" ? await tempPasswordSecretFields(tempPassword!) : {}),
        ...(mode.kind === "password" ? await passwordSecretFields(mode.password) : {}),
        authProvider: mode.kind === "google" ? "google" : "password",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    if (loginId) {
      batch.set(db.doc(attnLoginIndexPath(loginId)), {
        loginId,
        attnId,
        academyId,
        authUid,
        role: "teacher",
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    if (hrRef && hrRef.id !== authUid && hrSnap?.exists) {
      batch.delete(hrRef);
    }
    await batch.commit();

    await admin.auth().setCustomUserClaims(authUid, {
      role: "teacher",
      academyId,
      membershipStatus: status,
    });
  } catch (e) {
    if (createdAuthUser) {
      await admin.auth().deleteUser(authUid).catch((err) => {
        logger.warn("provisionStaffAccount: auth rollback failed", { authUid, err });
      });
    }
    throw e;
  }

  return { authUid, attnId, loginId, displayName, ...(tempPassword ? { tempPassword } : {}) };
}

/**
 * 계정만 떼어 내고 인사 기록은 남김(사용 중·비활성 계정 삭제) — 계정 문서(`staff/{authUid}`)의 인사 정보를
 * 새 ID의 계정 없는 직원 문서(status no_account, 기본 역할·권한 없음)로 옮기고 계정 문서는 지운다.
 * 예전 uid 경로에 문서를 남기지 않아, 삭제된 계정의 아직 유효한 토큰이 멤버로 취급되지 않는다.
 * Auth 사용자·로그인 인덱스·secrets 정리는 호출 측에서. 새 직원 문서 ID를 돌려준다.
 */
export async function detachStaffAccount(
  db: admin.firestore.Firestore,
  academyId: string,
  accountSnap: admin.firestore.DocumentSnapshot,
): Promise<string> {
  const hr: Record<string, unknown> = {};
  for (const k of HR_FIELDS) {
    const v = accountSnap.get(k);
    if (v !== undefined) hr[k] = v;
  }
  const hrRef = db.collection(`academies/${academyId}/staff`).doc();
  const batch = db.batch();
  batch.set(hrRef, {
    displayName: "",
    phone: null,
    jobTitleId: null,
    hireDate: null,
    employmentStatus: "employed",
    memo: "",
    createdAt: FieldValue.serverTimestamp(),
    ...hr,
    academyId,
    status: "no_account",
    authUid: null,
    isGuest: false,
    roleId: DEFAULT_STAFF_ROLE_ID,
    permissions: [],
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.delete(accountSnap.ref);
  await batch.commit();
  return hrRef.id;
}
