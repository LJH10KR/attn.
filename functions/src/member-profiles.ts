import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { attnLoginIndexPath } from "./lib/attn-id";
import { autoLinkVerifiedParent } from "./lib/parent-auto-link";
import {
  applyVerifiedParentPhone,
  MSG_PHONE_CHANGE_NEEDS_PROOF,
  writeParentPhoneBell,
} from "./lib/parent-phone-change";
import { accountProofExpectation, readOptionalPhoneProof } from "./lib/phone-proof";
import { readPhoneProofInTx, verifiedPhoneFields } from "./lib/phone-verification";
import {
  assertMemberLoginIdAvailable,
  normalizeMemberLoginId,
  validateMemberLoginIdFormat,
} from "./lib/member-login-id";
import { digitsOnlyKrPhone, parseOptionalKrPhone } from "./lib/kr-phone";
import { parentPhoneIndexRef } from "./lib/parent-links";
import { verifyLoginPasswordThrottled } from "./lib/login-throttle";
import { randomAuthPassword } from "./lib/member-credentials";
import { hasLoginSecret, passwordSecretFields } from "./lib/password-hash";
import type { DocumentReference } from "firebase-admin/firestore";
import { isParentLoginEmail, normalizeParentLoginEmail } from "./lib/parent-login-id";
import { syncUserAdminProfile } from "./lib/firestore-cleanup";

function teacherAcademyIdFromMemberPath(path: string): string | null {
  const m = path.match(/^academies\/([^/]+)\/staff\//);
  return m ? m[1] : null;
}

async function assertTeacherAuth(request: {
  auth?: { uid: string; token: Record<string, unknown> };
}): Promise<{ uid: string; academyId: string; memberDocId: string }> {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const uid = request.auth.uid;
  const token = request.auth.token;
  const claimAcademyId = typeof token.academyId === "string" ? token.academyId : "";
  if (token.role === "teacher" && claimAcademyId) {
    return { uid, academyId: claimAcademyId, memberDocId: uid };
  }

  const snaps = await admin
    .firestore()
    .collectionGroup("staff")
    .where("authUid", "==", uid)
    .limit(10)
    .get();
  if (snaps.empty) {
    throw new HttpsError("permission-denied", "선생님 계정만 수정할 수 있습니다.");
  }
  const preferred =
    snaps.docs.find((d) => d.get("status") === "active") ?? snaps.docs[0]!;
  const academyId = teacherAcademyIdFromMemberPath(preferred.ref.path);
  if (!academyId) {
    throw new HttpsError("failed-precondition", "학원 정보가 없습니다.");
  }
  return { uid, academyId, memberDocId: preferred.id };
}

function assertParentAuth(request: {
  auth?: { uid: string; token: Record<string, unknown> };
}): { uid: string; academyId: string } {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const token = request.auth.token;
  if (token.role !== "parent") {
    throw new HttpsError("permission-denied", "학부모 계정만 수정할 수 있습니다.");
  }
  const academyId = typeof token.academyId === "string" ? token.academyId : "";
  if (!academyId) {
    throw new HttpsError("failed-precondition", "학원 정보가 없습니다.");
  }
  return { uid: request.auth.uid, academyId };
}

async function verifyMemberLoginPassword(
  academyId: string,
  uid: string,
  role: "teacher" | "parent",
  password: string,
): Promise<void> {
  // 로그인과 같은 연속 실패 잠금 — 열린 세션으로 현재 비밀번호를 대입해 알아내지 못하게
  const col = role === "teacher" ? "staff" : "parents";
  const db = admin.firestore();
  await verifyLoginPasswordThrottled(
    db,
    db.doc(`academies/${academyId}/${col}/${uid}/secrets/login`),
    password,
    "현재 비밀번호가 올바르지 않습니다.",
  );
}

async function parentHasStoredPassword(academyId: string, uid: string): Promise<boolean> {
  const secretSnap = await admin
    .firestore()
    .doc(`academies/${academyId}/parents/${uid}/secrets/login`)
    .get();
  return hasLoginSecret(secretSnap.data());
}

function assertDisplayName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > 60) {
    throw new HttpsError("invalid-argument", "이름을 1~60자로 입력해 주세요.");
  }
  return name;
}

/** 요청에 이름이 있으면 검사(없으면 그대로 둠 — 번호 바꾸기 시트는 번호만 보냄) */
function optionalDisplayName(data: Record<string, unknown> | undefined): string | undefined {
  return data != null && "displayName" in data ? assertDisplayName(data.displayName) : undefined;
}

/**
 * 선생님 — 본인 표시 이름·전화번호 변경. 번호를 바꾸면 새 번호 확인 증표(`phoneProof`, 목적 phone_change·본인)가 필요하고(2-L L3-1-3),
 * 계정 번호와 확인 필드(`phoneVerifiedKey`·`phoneVerifiedAt`)를 한 트랜잭션에서 함께 바꾼다. 번호를 비우는 것은 증표 없이 되고 확인 필드도 지운다.
 * 같은 번호에 증표를 붙이면 확인 표시만 남긴다(가입 때 건너뛴 번호를 나중에 확인).
 */
export const updateTeacherProfile = onCall(async (request) => {
  const { uid, academyId, memberDocId } = await assertTeacherAuth(request);

  const displayName = optionalDisplayName(request.data);
  const hasPhoneField = request.data != null && "phone" in request.data;
  const phone = hasPhoneField ? parseOptionalKrPhone(request.data?.phone) : undefined;
  const phoneProof = readOptionalPhoneProof(request.data?.phoneProof);
  if (displayName === undefined && phone === undefined) {
    throw new HttpsError("invalid-argument", "바꿀 내용이 없습니다.");
  }
  const db = admin.firestore();
  const ref = db.doc(`academies/${academyId}/staff/${memberDocId}`);

  const result = await db.runTransaction(async (tx) => {
    const proof =
      phone && phoneProof ? await readPhoneProofInTx(tx, db, phoneProof, accountProofExpectation(uid, phone)) : null;
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError("not-found", "선생님 정보를 찾을 수 없습니다.");
    }
    const oldPhone = typeof snap.get("phone") === "string" ? (snap.get("phone") as string) : "";
    const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    if (displayName !== undefined) patch.displayName = displayName;
    if (phone === null) {
      patch.phone = null;
      patch.phoneVerifiedKey = FieldValue.delete();
      patch.phoneVerifiedAt = FieldValue.delete();
    } else if (phone !== undefined) {
      const changed = digitsOnlyKrPhone(phone) !== digitsOnlyKrPhone(oldPhone);
      if (changed && !proof) {
        throw new HttpsError("failed-precondition", MSG_PHONE_CHANGE_NEEDS_PROOF);
      }
      patch.phone = phone;
      if (proof) Object.assign(patch, verifiedPhoneFields(proof.phoneKey));
    }
    tx.update(ref, patch);
    proof?.markUsed(uid);
    return {
      status: snap.get("status"),
      displayName: displayName ?? (typeof snap.get("displayName") === "string" ? (snap.get("displayName") as string) : ""),
      phoneVerified: proof !== null,
    };
  });
  if (displayName !== undefined) {
    try {
      await admin.auth().updateUser(uid, { displayName });
    } catch {
      /* Auth displayName은 부가 정보 */
    }
  }

  const membershipStatus = typeof result.status === "string" ? result.status : "pending_setup";
  await admin.auth().setCustomUserClaims(uid, {
    role: "teacher",
    academyId,
    membershipStatus,
  });
  await syncUserAdminProfile(admin.firestore(), uid);

  return {
    ok: true,
    displayName: result.displayName,
    ...(phone !== undefined ? { phone } : {}),
    phoneVerified: result.phoneVerified,
  };
});

/**
 * 학부모 — 본인 표시 이름·휴대폰 번호 변경(2-L L3-1-1). 번호를 바꾸면 새 번호 확인 증표가 필요하고,
 * `applyVerifiedParentPhone` 한 트랜잭션이 계정 번호·확인 필드·번호 색인·연결된 모든 자녀 보호자 칸(★9 합치기)·안내 정리를 함께 한다.
 * 그 뒤 원장 벨(번호가 바뀐 경우)과 ★8 자동 연결(연결 자녀 수와 상관없이 매번 — 그 번호의 원생 전체).
 * 같은 번호에 증표를 붙이면 확인 표시만 남기고 자동 연결을 시도한다(가입 때 건너뛴 번호를 나중에 확인).
 * 번호 비우기는 증표 없이 되지만 학원에 연결된 계정(번호 색인 보유)은 거부.
 */
export const updateParentProfile = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const uid = request.auth.uid;
  const token = request.auth.token;
  if (token.role !== "parent") {
    throw new HttpsError("permission-denied", "학부모 계정만 수정할 수 있습니다.");
  }
  const academyId = typeof token.academyId === "string" ? token.academyId : "";
  if (!academyId) {
    throw new HttpsError("failed-precondition", "학원 정보가 없습니다.");
  }

  const displayName = optionalDisplayName(request.data);
  const hasPhoneField = request.data != null && "phone" in request.data;
  const phone = hasPhoneField ? parseOptionalKrPhone(request.data?.phone) : undefined;
  const phoneProof = readOptionalPhoneProof(request.data?.phoneProof);
  if (displayName === undefined && phone === undefined) {
    throw new HttpsError("invalid-argument", "바꿀 내용이 없습니다.");
  }
  const db = admin.firestore();
  const ref = db.doc(`academies/${academyId}/parents/${uid}`);

  const finish = async (name: string | undefined) => {
    if (name !== undefined) {
      try {
        await admin.auth().updateUser(uid, { displayName: name });
      } catch {
        /* optional */
      }
    }
    await syncUserAdminProfile(db, uid);
  };

  if (phone && phoneProof) {
    // 문자로 확인된 번호 — 한 트랜잭션 적용 → 벨 → ★8 매번 자동 연결
    const applied = await applyVerifiedParentPhone(db, academyId, uid, { phone, rawProof: phoneProof, displayName });
    if (applied.phoneChanged) {
      await writeParentPhoneBell(db, academyId, uid, applied.displayName, "self").catch((e) =>
        logger.warn("updateParentProfile: 원장 벨 실패(무시)", { academyId, e }),
      );
    }
    const auto = await autoLinkVerifiedParent(db, academyId, uid);
    await finish(displayName);
    return {
      ok: true,
      displayName: applied.displayName,
      phone,
      phoneVerified: true,
      linkedCount: auto.linked.length,
    };
  }

  // 증표 없음 — 이름만, 같은 번호, 번호 비우기(연결된 계정은 거부)만 된다
  const name = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError("not-found", "학부모 정보를 찾을 수 없습니다.");
    }
    const oldPhone = typeof snap.get("phone") === "string" ? (snap.get("phone") as string) : "";
    const oldKey = digitsOnlyKrPhone(oldPhone);
    const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    if (displayName !== undefined) patch.displayName = displayName;
    if (phone === null && oldKey) {
      const idx = await tx.get(parentPhoneIndexRef(db, academyId, oldKey));
      if (idx.exists && idx.get("parentUid") === uid) {
        throw new HttpsError("invalid-argument", "학원에 연결된 계정은 휴대폰 번호를 비울 수 없습니다.");
      }
      patch.phone = null;
      patch.phoneVerifiedKey = FieldValue.delete();
      patch.phoneVerifiedAt = FieldValue.delete();
    } else if (phone && digitsOnlyKrPhone(phone) !== oldKey) {
      throw new HttpsError("failed-precondition", MSG_PHONE_CHANGE_NEEDS_PROOF);
    }
    tx.update(ref, patch);
    return displayName ?? (typeof snap.get("displayName") === "string" ? (snap.get("displayName") as string) : "");
  });
  await finish(displayName);

  return {
    ok: true,
    displayName: name,
    ...(phone !== undefined ? { phone } : {}),
    phoneVerified: false,
    linkedCount: 0,
  };
});

function googleEmailFromUser(user: admin.auth.UserRecord): string {
  const p = user.providerData.find((x) => x.providerId === "google.com");
  const email = typeof p?.email === "string" ? p.email.trim() : "";
  if (!email) {
    throw new HttpsError(
      "failed-precondition",
      "Google 계정 이메일을 확인할 수 없습니다.",
    );
  }
  return normalizeParentLoginEmail(email);
}

/** 학부모 — Firebase Auth에 Google 연동 후 Firestore 동기화 */
export const syncParentGoogleLink = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const uid = request.auth.uid;
  const token = request.auth.token;
  if (token.role !== "parent") {
    throw new HttpsError("permission-denied", "학부모 계정만 연동할 수 있습니다.");
  }
  const academyId = typeof token.academyId === "string" ? token.academyId : "";
  if (!academyId) {
    throw new HttpsError("failed-precondition", "학원 정보가 없습니다.");
  }

  const user = await admin.auth().getUser(uid);
  const hasGoogle = user.providerData.some((p) => p.providerId === "google.com");
  if (!hasGoogle) {
    throw new HttpsError(
      "failed-precondition",
      "Google 계정 연결 후 다시 시도해 주세요.",
    );
  }
  const googleEmail = googleEmailFromUser(user);

  const memberRef = admin.firestore().doc(`academies/${academyId}/parents/${uid}`);
  const snap = await memberRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "학부모 정보를 찾을 수 없습니다.");
  }

  const authProvider = snap.get("authProvider");
  const patch: Record<string, unknown> = {
    googleLinked: true,
    googleEmail,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (authProvider === "google") {
    patch.email = googleEmail;
  }

  await memberRef.update(patch);
  await admin
    .firestore()
    .doc(`academies/${academyId}/parents/${uid}/secrets/login`)
    .set({ googleLinked: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  return { ok: true, googleEmail };
});

/** 선생님 — Firebase Auth에 Google 연동 후 Firestore 동기화 */
export const syncTeacherGoogleLink = onCall(async (request) => {
  const { uid, academyId, memberDocId } = await assertTeacherAuth(request);

  const user = await admin.auth().getUser(uid);
  const hasGoogle = user.providerData.some((p) => p.providerId === "google.com");
  if (!hasGoogle) {
    throw new HttpsError(
      "failed-precondition",
      "Google 계정 연결 후 다시 시도해 주세요.",
    );
  }
  const googleEmail = googleEmailFromUser(user);

  const memberRef = admin
    .firestore()
    .doc(`academies/${academyId}/staff/${memberDocId}`);
  const snap = await memberRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "선생님 정보를 찾을 수 없습니다.");
  }

  await memberRef.update({
    googleLinked: true,
    googleEmail,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await admin
    .firestore()
    .doc(`academies/${academyId}/staff/${memberDocId}/secrets/login`)
    .set({ googleLinked: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  return { ok: true, googleEmail };
});

/** 공개 — 선생님 로그인 ID(별칭) 변경 가능 여부 */
export const checkTeacherLoginIdAvailable = onCall(async (request) => {
  const { uid, academyId, memberDocId } = await assertTeacherAuth(request);
  const raw =
    typeof request.data?.loginId === "string" ? request.data.loginId.trim() : "";
  if (!raw) {
    throw new HttpsError("invalid-argument", "로그인 ID를 입력해 주세요.");
  }
  try {
    validateMemberLoginIdFormat(raw);
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError("invalid-argument", "로그인 ID 형식이 올바르지 않습니다.");
  }

  const memberSnap = await admin
    .firestore()
    .doc(`academies/${academyId}/staff/${memberDocId}`)
    .get();
  const currentLoginId =
    typeof memberSnap.get("loginId") === "string" ? memberSnap.get("loginId") : "";
  const normalized = normalizeMemberLoginId(raw);
  if (normalized === currentLoginId) {
    return { available: true, loginId: normalized, sameAsCurrent: true };
  }

  const indexSnap = await admin.firestore().doc(attnLoginIndexPath(normalized)).get();
  if (indexSnap.exists && indexSnap.get("authUid") !== uid) {
    throw new HttpsError("already-exists", "이미 사용 중인 로그인 ID입니다.");
  }
  return { available: true, loginId: normalized };
});

/** 선생님 — 로그인 ID(별칭) 변경 — attnId(관리 번호)는 유지 */
export const updateTeacherLoginId = onCall(async (request) => {
  const { uid, academyId, memberDocId } = await assertTeacherAuth(request);
  const newLoginIdRaw =
    typeof request.data?.loginId === "string" ? request.data.loginId.trim() : "";
  const currentPassword =
    typeof request.data?.currentPassword === "string"
      ? request.data.currentPassword
      : "";
  if (!newLoginIdRaw) {
    throw new HttpsError("invalid-argument", "새 로그인 ID를 입력해 주세요.");
  }
  if (!currentPassword) {
    throw new HttpsError("invalid-argument", "현재 비밀번호를 입력해 주세요.");
  }

  await verifyMemberLoginPassword(academyId, uid, "teacher", currentPassword);

  const db = admin.firestore();
  const memberRef = db.doc(`academies/${academyId}/staff/${memberDocId}`);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) {
    throw new HttpsError("not-found", "선생님 정보를 찾을 수 없습니다.");
  }
  const oldLoginId =
    typeof memberSnap.get("loginId") === "string" ? memberSnap.get("loginId") : "";

  const newLoginId = await assertMemberLoginIdAvailable(db, newLoginIdRaw, uid);
  if (newLoginId === oldLoginId) {
    return { ok: true, loginId: newLoginId };
  }

  const newIndexRef = db.doc(attnLoginIndexPath(newLoginId));

  await db.runTransaction(async (tx) => {
    const freshMember = await tx.get(memberRef);
    const prevLoginId =
      typeof freshMember.get("loginId") === "string" ? freshMember.get("loginId") : "";
    const memberAttnId =
      typeof freshMember.get("attnId") === "string" ? freshMember.get("attnId") : "";
    if (newLoginId === prevLoginId) {
      return;
    }
    const newIndexSnap = await tx.get(newIndexRef);
    if (newIndexSnap.exists && newIndexSnap.get("authUid") !== uid) {
      throw new HttpsError("already-exists", "이미 사용 중인 로그인 ID입니다.");
    }
    const prevKeys = new Set<string>();
    if (prevLoginId) prevKeys.add(prevLoginId);
    if (memberAttnId) prevKeys.add(memberAttnId);
    const indexDeletes: DocumentReference[] = [];
    for (const key of prevKeys) {
      if (!key || key === newLoginId) continue;
      const oldIndexRef = db.doc(attnLoginIndexPath(key));
      const oldIndexSnap = await tx.get(oldIndexRef);
      if (oldIndexSnap.exists && oldIndexSnap.get("authUid") === uid) {
        indexDeletes.push(oldIndexRef);
      }
    }
    for (const oldIndexRef of indexDeletes) {
      tx.delete(oldIndexRef);
    }
    tx.set(newIndexRef, {
      loginId: newLoginId,
      attnId: memberAttnId,
      academyId,
      authUid: uid,
      role: "teacher",
      updatedAt: FieldValue.serverTimestamp(),
      ...(newIndexSnap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    });
    tx.update(memberRef, {
      loginId: newLoginId,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { ok: true, loginId: newLoginId };
});

/** 학부모 — 로그인 ID(별칭) 변경 가능 여부 */
export const checkParentLoginIdForUpdate = onCall(async (request) => {
  const { uid, academyId } = assertParentAuth(request);
  const raw =
    typeof request.data?.loginId === "string" ? request.data.loginId.trim() : "";
  if (!raw) {
    throw new HttpsError("invalid-argument", "로그인 ID를 입력해 주세요.");
  }
  if (isParentLoginEmail(raw)) {
    throw new HttpsError(
      "invalid-argument",
      "로그인 ID는 한글 또는 영문 별칭만 사용할 수 있습니다.",
    );
  }
  try {
    validateMemberLoginIdFormat(raw);
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError("invalid-argument", "로그인 ID 형식이 올바르지 않습니다.");
  }

  const memberSnap = await admin
    .firestore()
    .doc(`academies/${academyId}/parents/${uid}`)
    .get();
  const currentLoginId =
    typeof memberSnap.get("loginId") === "string" ? memberSnap.get("loginId") : "";
  const normalized = normalizeMemberLoginId(raw);
  if (normalized === currentLoginId) {
    return { available: true, loginId: normalized, sameAsCurrent: true };
  }

  const indexSnap = await admin.firestore().doc(attnLoginIndexPath(normalized)).get();
  if (indexSnap.exists && indexSnap.get("authUid") !== uid) {
    throw new HttpsError("already-exists", "이미 사용 중인 로그인 ID입니다.");
  }
  return { available: true, loginId: normalized };
});

/** 학부모 — 로그인 ID(별칭) 변경 — attnId(관리 번호)는 유지 */
export const updateParentLoginId = onCall(async (request) => {
  const { uid, academyId } = assertParentAuth(request);
  const newLoginIdRaw =
    typeof request.data?.loginId === "string" ? request.data.loginId.trim() : "";
  const currentPassword =
    typeof request.data?.currentPassword === "string"
      ? request.data.currentPassword
      : "";
  if (!newLoginIdRaw) {
    throw new HttpsError("invalid-argument", "새 로그인 ID를 입력해 주세요.");
  }
  if (isParentLoginEmail(newLoginIdRaw)) {
    throw new HttpsError(
      "invalid-argument",
      "로그인 ID는 한글 또는 영문 별칭만 사용할 수 있습니다.",
    );
  }

  const db = admin.firestore();
  const memberRef = db.doc(`academies/${academyId}/parents/${uid}`);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) {
    throw new HttpsError("not-found", "학부모 정보를 찾을 수 없습니다.");
  }

  const hasPassword = await parentHasStoredPassword(academyId, uid);
  const authProvider = memberSnap.get("authProvider");
  if (hasPassword || authProvider !== "google") {
    if (!currentPassword) {
      throw new HttpsError("invalid-argument", "현재 비밀번호를 입력해 주세요.");
    }
    await verifyMemberLoginPassword(academyId, uid, "parent", currentPassword);
  }

  const oldLoginId =
    typeof memberSnap.get("loginId") === "string" ? memberSnap.get("loginId") : "";
  const newLoginId = await assertMemberLoginIdAvailable(db, newLoginIdRaw, uid);
  if (newLoginId === oldLoginId) {
    return { ok: true, loginId: newLoginId };
  }

  const newIndexRef = db.doc(attnLoginIndexPath(newLoginId));

  await db.runTransaction(async (tx) => {
    const freshMember = await tx.get(memberRef);
    const prevLoginId =
      typeof freshMember.get("loginId") === "string" ? freshMember.get("loginId") : "";
    const memberAttnId =
      typeof freshMember.get("attnId") === "string" ? freshMember.get("attnId") : "";
    if (newLoginId === prevLoginId) {
      return;
    }
    const newIndexSnap = await tx.get(newIndexRef);
    if (newIndexSnap.exists && newIndexSnap.get("authUid") !== uid) {
      throw new HttpsError("already-exists", "이미 사용 중인 로그인 ID입니다.");
    }

    const prevKeys = new Set<string>();
    if (prevLoginId) prevKeys.add(prevLoginId);
    if (memberAttnId) prevKeys.add(memberAttnId);
    if (prevLoginId.includes("@")) {
      prevKeys.add(normalizeParentLoginEmail(prevLoginId));
    }

    const indexDeletes: DocumentReference[] = [];
    for (const key of prevKeys) {
      if (!key || key === newLoginId) continue;
      const oldIndexRef = db.doc(attnLoginIndexPath(key));
      const oldIndexSnap = await tx.get(oldIndexRef);
      if (oldIndexSnap.exists && oldIndexSnap.get("authUid") === uid) {
        indexDeletes.push(oldIndexRef);
      }
    }

    const indexAuthProvider =
      freshMember.get("authProvider") === "google" && !hasPassword ? "google" : "password";
    for (const oldIndexRef of indexDeletes) {
      tx.delete(oldIndexRef);
    }
    tx.set(newIndexRef, {
      loginId: newLoginId,
      attnId: memberAttnId,
      academyId,
      authUid: uid,
      role: "parent",
      authProvider: indexAuthProvider,
      updatedAt: FieldValue.serverTimestamp(),
      ...(newIndexSnap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    });
    tx.update(memberRef, {
      loginId: newLoginId,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { ok: true, loginId: newLoginId };
});

/** 선생님 — 비밀번호 변경 */
export const updateTeacherPassword = onCall(async (request) => {
  const { uid, academyId, memberDocId } = await assertTeacherAuth(request);
  const currentPassword =
    typeof request.data?.currentPassword === "string"
      ? request.data.currentPassword
      : "";
  const newPassword =
    typeof request.data?.newPassword === "string" ? request.data.newPassword : "";
  if (!currentPassword) {
    throw new HttpsError("invalid-argument", "현재 비밀번호를 입력해 주세요.");
  }
  if (newPassword.length < 6) {
    throw new HttpsError("invalid-argument", "새 비밀번호는 6자 이상이어야 합니다.");
  }
  if (currentPassword === newPassword) {
    throw new HttpsError(
      "invalid-argument",
      "새 비밀번호는 현재 비밀번호와 달라야 합니다.",
    );
  }

  await verifyMemberLoginPassword(academyId, uid, "teacher", currentPassword);

  await admin.auth().updateUser(uid, { password: randomAuthPassword() });
  await admin
    .firestore()
    .doc(`academies/${academyId}/staff/${memberDocId}/secrets/login`)
    .set(await passwordSecretFields(newPassword), { merge: true });

  return { ok: true };
});

/** 학부모 — 비밀번호 등록·변경 (Google 연동 후에도 가능) */
export const updateParentPassword = onCall(async (request) => {
  const { uid, academyId } = assertParentAuth(request);
  const register = request.data?.register === true;
  const currentPassword =
    typeof request.data?.currentPassword === "string"
      ? request.data.currentPassword
      : "";
  const newPassword =
    typeof request.data?.newPassword === "string" ? request.data.newPassword : "";
  if (newPassword.length < 6) {
    throw new HttpsError("invalid-argument", "새 비밀번호는 6자 이상이어야 합니다.");
  }

  const memberRef = admin.firestore().doc(`academies/${academyId}/parents/${uid}`);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) {
    throw new HttpsError("not-found", "학부모 정보를 찾을 수 없습니다.");
  }

  const hasPassword = await parentHasStoredPassword(academyId, uid);
  const isRegister = register || (!hasPassword && memberSnap.get("authProvider") === "google");

  if (isRegister) {
    const user = await admin.auth().getUser(uid);
    const hasGoogle = user.providerData.some((p) => p.providerId === "google.com");
    if (!hasGoogle) {
      throw new HttpsError(
        "failed-precondition",
        "Google 계정으로 로그인한 뒤 비밀번호를 등록해 주세요.",
      );
    }
  } else {
    if (!currentPassword) {
      throw new HttpsError("invalid-argument", "현재 비밀번호를 입력해 주세요.");
    }
    if (currentPassword === newPassword) {
      throw new HttpsError(
        "invalid-argument",
        "새 비밀번호는 현재 비밀번호와 달라야 합니다.",
      );
    }
    await verifyMemberLoginPassword(academyId, uid, "parent", currentPassword);
  }

  await admin.auth().updateUser(uid, { password: randomAuthPassword() });
  await admin
    .firestore()
    .doc(`academies/${academyId}/parents/${uid}/secrets/login`)
    .set(await passwordSecretFields(newPassword), { merge: true });

  const loginId =
    typeof memberSnap.get("loginId") === "string" ? memberSnap.get("loginId") : "";
  const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (isRegister) {
    patch.authProvider = "password";
  }
  await memberRef.update(patch);

  if (loginId) {
    await admin
      .firestore()
      .doc(attnLoginIndexPath(loginId))
      .set(
        {
          authProvider: "password",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  }

  return { ok: true, registered: isRegister };
});
