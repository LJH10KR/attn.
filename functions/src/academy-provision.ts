import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  ATTN_ID_GLOBAL_META,
  academySeqMetaPath,
  formatAcademyAttnId,
  formatOwnerAttnId,
} from "./lib/attn-id";
import { ensureAcademyRoleTemplates } from "./roles";
import { academyOptionsRef, DEFAULT_GUARDIAN_RELATIONS } from "./academy-options";

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
    nextStudentSeq: 1,
  });
  await academyOptionsRef(db, academyId).set({
    guardianRelations: DEFAULT_GUARDIAN_RELATIONS,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await ensureAcademyRoleTemplates(db, academyId);

  return {
    academyId,
    attnId: academyId,
    name,
  };
});
