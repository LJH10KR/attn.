import * as admin from "firebase-admin";
import { FieldValue, type DocumentReference, type Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { academySeqMetaPath, attnLoginIndexPath, formatTeacherAttnId } from "./attn-id";
import { randomAuthPassword, randomTempPassword } from "./member-credentials";
import { assertMemberLoginIdAvailable } from "./member-login-id";
import { passwordSecretFields, tempPasswordSecretFields } from "./password-hash";
import { DEFAULT_STAFF_ROLE_ID, normalizePermissionList, type AcademyPermission } from "./permissions";
import { allocateTeacherLoginId } from "./teacher-login-id";

/**
 * 직원 계정 만들기 — 공용 직원 가입 링크(`staff-signup.ts`)와 직접 만들어 주기(`staff-accounts.ts`) 공용.
 * 계정 없는 직원 문서(인사 정보)가 있으면 그 내용을 `staff/{authUid}`로 옮기고 원래 문서를 지운다.
 */

/** 인사 정보 중 계정 문서로 옮기는 필드 — 계정·권한 필드는 새로 씀 */
export const HR_FIELDS = [
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
  /** 가입하는 사람이 로그인 ID·비밀번호를 직접 정함 */
  | { kind: "password"; loginId: string; password: string }
  /** 가입하는 사람이 Google 계정으로 가입(이미 로그인된 uid) */
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
  /** 공용 링크 가입 — 가입할 때 적은 번호와 가입 경로 */
  signup?: { phone: string; signupSource: "staff_link" };
  /**
   * 계정 문서 쓰기 트랜잭션에 함께 넣을 일(2-L — 번호 확인 증표 소비·동의 기록).
   * 읽기 단계에서 불리며, 돌려준 `fields`는 계정 문서에 더하고 `write`는 쓰기 단계에서 부른다.
   */
  inTx?: (tx: Transaction, authUid: string) => Promise<{ fields?: Record<string, unknown>; write?: () => void }>;
}): Promise<ProvisionedStaffAccount> {
  const { db, academyId, hrRef, displayName, roleId, permissions, mode, status, signup, inTx } = params;

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
    const secretFields = {
      ...(mode.kind === "temp" ? await tempPasswordSecretFields(tempPassword!) : {}),
      ...(mode.kind === "password" ? await passwordSecretFields(mode.password) : {}),
    };
    const memberRef = db.doc(`academies/${academyId}/staff/${authUid}`);
    // 계정 문서·로그인 정보·색인·인사 문서 정리(+ 증표 소비)를 한 트랜잭션에서
    await db.runTransaction(async (tx) => {
      const extra = inTx ? await inTx(tx, authUid) : {};
      const hrSnap = hrRef ? await tx.get(hrRef) : null;
      const hr: Record<string, unknown> = {};
      if (hrSnap?.exists) {
        for (const k of HR_FIELDS) {
          const v = hrSnap.get(k);
          if (v !== undefined) hr[k] = v;
        }
      }

      tx.set(memberRef, {
        employmentStatus: "employed",
        createdAt: FieldValue.serverTimestamp(),
        ...hr,
        ...(signup ? { phone: signup.phone, signupSource: signup.signupSource } : {}),
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
        ...(extra.fields ?? {}),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(
        memberRef.collection("secrets").doc("login"),
        {
          ...secretFields,
          authProvider: mode.kind === "google" ? "google" : "password",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      if (loginId) {
        tx.set(db.doc(attnLoginIndexPath(loginId)), {
          loginId,
          attnId,
          academyId,
          authUid,
          role: "teacher",
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      if (hrRef && hrRef.id !== authUid && hrSnap?.exists) {
        tx.delete(hrRef);
      }
      extra.write?.();
    });

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

/** 직원 계정 활성 마무리 — 클레임 active + Auth 계정 켜기(승인·다시 활성화·합쳐 승인 공용) */
export async function finishStaffActivation(academyId: string, authUid: string): Promise<void> {
  await admin.auth().setCustomUserClaims(authUid, {
    role: "teacher",
    academyId,
    membershipStatus: "active",
  });
  await admin.auth().updateUser(authUid, { disabled: false });
}

/**
 * 계정만 떼어 내고 인사 기록은 남김(사용 중·비활성 계정 삭제) — 계정 문서(`staff/{authUid}`)의 인사 정보를
 * 새 ID의 계정 없는 직원 문서(status no_account, 기본 역할·권한 없음)로 옮기고 계정 문서는 지운다.
 * 예전 uid 경로에 문서를 남기지 않아, 삭제된 계정의 아직 유효한 토큰이 멤버로 취급되지 않는다.
 * Auth 사용자·로그인 인덱스·secrets 정리는 호출 측에서. 새 직원 문서 ID를 돌려준다.
 * 2-N(F6): 트랜잭션 — 동시에 두 번 불려도(탈퇴 두 기기·삭제 두 번 누름) 인사 기록은 하나. 계정 문서가 이미 없으면 null.
 */
export async function detachStaffAccount(
  db: admin.firestore.Firestore,
  academyId: string,
  accountRef: admin.firestore.DocumentReference,
): Promise<string | null> {
  const hrRef = db.collection(`academies/${academyId}/staff`).doc();
  return db.runTransaction(async (tx) => {
    const accountSnap = await tx.get(accountRef);
    if (!accountSnap.exists) return null;
    const hr: Record<string, unknown> = {};
    for (const k of HR_FIELDS) {
      const v = accountSnap.get(k);
      if (v !== undefined) hr[k] = v;
    }
    tx.set(hrRef, {
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
    tx.delete(accountRef);
    return hrRef.id;
  });
}
