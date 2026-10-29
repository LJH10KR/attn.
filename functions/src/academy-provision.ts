import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  ATTN_ID_GLOBAL_META,
  academySeqMetaPath,
  formatAcademyAttnId,
  formatOwnerAttnId,
  formatParentAttnId,
} from "./lib/attn-id";
import { assertPermission } from "./lib/academy-access";
import { ensureAcademyRoleTemplates } from "./roles";
import {
  provisionMemberAccount,
  provisionTemplateStudentsForParent,
} from "./lib/member-credentials";
import { pickTemplateDisplayNameUnique } from "./lib/korean-template-names";

async function ensureOwnerAttnSeq(
  db: admin.firestore.Firestore,
  ownerUid: string,
): Promise<string> {
  const userRef = db.doc(`users/${ownerUid}`);
  const globalRef = db.doc(ATTN_ID_GLOBAL_META);

  return db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    const existing = userSnap.get("ownerAttnSeq");
    if (typeof existing === "string" && existing) {
      return existing;
    }
    const globalSnap = await tx.get(globalRef);
    const nextOwner = (globalSnap.get("nextOwnerSeq") as number) || 1;
    const ownerAttnSeq = formatOwnerAttnId(nextOwner);
    tx.set(globalRef, { nextOwnerSeq: nextOwner + 1 }, { merge: true });
    tx.set(
      userRef,
      {
        ownerAttnSeq,
        nextAcademySeq: userSnap.get("nextAcademySeq") ?? 1,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return ownerAttnSeq;
  });
}

async function allocateAcademyAttnId(
  db: admin.firestore.Firestore,
  ownerUid: string,
  ownerAttnSeq: string,
): Promise<string> {
  const userRef = db.doc(`users/${ownerUid}`);
  return db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    const nextAcademySeq = (userSnap.get("nextAcademySeq") as number) || 1;
    const academyAttnId = formatAcademyAttnId(ownerAttnSeq, nextAcademySeq);
    tx.set(
      userRef,
      { nextAcademySeq: nextAcademySeq + 1, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return academyAttnId;
  });
}

function clampCount(raw: unknown, max: number, label: string): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > max) {
    throw new HttpsError("invalid-argument", `${label}은(는) 0~${max} 사이여야 합니다.`);
  }
  return Math.floor(n);
}

/** 오너 — 학원 1개 생성(이름만). 원장·직원은 각자 계정으로 로그인(학원 공용 로그인 없음) */
export const createAcademyEasy = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }

  const name = typeof request.data?.name === "string" ? request.data.name.trim() : "";
  if (!name || name.length > 80) {
    throw new HttpsError("invalid-argument", "학원 이름을 1~80자로 입력해 주세요.");
  }

  const db = admin.firestore();
  const ownerAttnSeq = await ensureOwnerAttnSeq(db, uid);
  const academyId = await allocateAcademyAttnId(db, uid, ownerAttnSeq);

  const existing = await db.doc(`academies/${academyId}`).get();
  if (existing.exists) {
    throw new HttpsError("already-exists", "학원 ID가 이미 사용 중입니다. 다시 시도해 주세요.");
  }

  await db.doc(`academies/${academyId}`).set({
    attnId: academyId,
    ownerUid: uid,
    ownerAttnSeq,
    name,
    status: "active",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await db.doc(academySeqMetaPath(academyId)).set({
    nextTeacherSeq: 1,
    nextParentSeq: 1,
  });
  await ensureAcademyRoleTemplates(db, academyId);

  return {
    academyId,
    attnId: academyId,
    name,
  };
});

/** 오너/학원 — 템플릿 학부모 N명 + 부모당 자녀 2명 */
async function runProvisionTemplateParents(request: {
  auth?: { uid?: string; token?: Record<string, unknown> };
  data?: Record<string, unknown>;
}) {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const count = clampCount(request.data?.count, 50, "학부모 수");
  const childrenPerParent = clampCount(
    request.data?.childrenPerParent ?? 2,
    10,
    "자녀 수",
  );
  if (!academyId) {
    throw new HttpsError("invalid-argument", "학원 ID가 필요합니다.");
  }

  const db = admin.firestore();
  await assertPermission(db, academyId, uid, token as admin.auth.DecodedIdToken, "operations.parents");

  const usedNames = new Set<string>();
  const parentAttnIds: string[] = [];

  await db.runTransaction(async (tx) => {
    const seqRef = db.doc(academySeqMetaPath(academyId));
    const seqSnap = await tx.get(seqRef);
    let nextParentSeq = (seqSnap.get("nextParentSeq") as number) || 1;

    for (let i = 0; i < count; i++) {
      const parentSeq = nextParentSeq;
      nextParentSeq += 1;
      parentAttnIds.push(formatParentAttnId(academyId, parentSeq));
    }

    tx.set(seqRef, { nextParentSeq }, { merge: true });
  });

  const parents: Array<{
    attnId: string;
    displayName: string;
    tempPassword: string;
    authUid: string;
    children: Array<{ attnId: string; name: string }>;
  }> = [];

  for (const attnId of parentAttnIds) {
    const displayName = pickTemplateDisplayNameUnique(usedNames);
    const member = await provisionMemberAccount({
      db,
      academyId,
      attnId,
      role: "parent",
      displayName,
    });
    const children = await provisionTemplateStudentsForParent({
      db,
      academyId,
      parentAuthUid: member.authUid,
      parentAttnId: attnId,
      count: childrenPerParent,
    });
    parents.push({
      attnId: member.attnId,
      displayName: member.displayName,
      tempPassword: member.tempPassword,
      authUid: member.authUid,
      children: children.map((c) => ({ attnId: c.attnId, name: c.name })),
    });
  }

  return { parents };
}

export const provisionTemplateParents = onCall(async (request) =>
  runProvisionTemplateParents(request),
);

/** 학원 — 학부모 추가 발급 (대시보드) */
export const provisionParentsBatch = onCall(async (request) =>
  runProvisionTemplateParents(request),
);

/** 학원 — 특정 학부모에게 자녀 N명 */
export const provisionStudentsBatch = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid, token } = request.auth;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const parentAuthUid =
    typeof request.data?.parentAuthUid === "string" ? request.data.parentAuthUid.trim() : "";
  const count = clampCount(request.data?.count, 20, "자녀 수");
  if (!academyId || !parentAuthUid) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  await assertPermission(db, academyId, uid, token as admin.auth.DecodedIdToken, "operations.students");

  const parentSnap = await db.doc(`academies/${academyId}/parents/${parentAuthUid}`).get();
  if (!parentSnap.exists) {
    throw new HttpsError("not-found", "학부모를 찾을 수 없습니다.");
  }
  const parentAttnId = parentSnap.get("attnId");
  if (typeof parentAttnId !== "string") {
    throw new HttpsError("failed-precondition", "학부모 attnId가 없습니다.");
  }

  const children = await provisionTemplateStudentsForParent({
    db,
    academyId,
    parentAuthUid,
    parentAttnId,
    count,
  });

  return { students: children };
});
