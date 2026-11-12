import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

/**
 * 학원 삭제 표시(2-N B1) — 최상위 `_academyDeletions/{academyId}`(규칙 기본 거부, 서버만).
 * 학원 문서에 두지 않는 이유: 원장이 학원 문서를 클라이언트로 쓸 수 있어, 멤버 uid 목록을 조작해
 * 남의 Auth 계정을 지우게 만들 수 있기 때문. 여기의 `memberAuthUids`는 서버가 멤버 문서에서 읽은 값만.
 * 학원 삭제가 끝나면(학원 문서 삭제 뒤) 지운다 — 남아 있으면 중간에 멈춘 삭제(잔여 점검 ⑦).
 */

export function academyDeletionRef(db: admin.firestore.Firestore, academyId: string) {
  return db.doc(`_academyDeletions/${academyId}`);
}

export async function markAcademyDeletion(
  db: admin.firestore.Firestore,
  academyId: string,
  fields: { requestedBy: string; context: string; ownerUid: string; memberAuthUids: string[] },
): Promise<void> {
  const ref = academyDeletionRef(db, academyId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    tx.set(
      ref,
      {
        academyId,
        ...(snap.exists ? {} : { startedAt: FieldValue.serverTimestamp() }),
        lastAttemptAt: FieldValue.serverTimestamp(),
        requestedBy: fields.requestedBy,
        context: fields.context,
        ownerUid: fields.ownerUid,
        ...(fields.memberAuthUids.length > 0
          ? { memberAuthUids: FieldValue.arrayUnion(...fields.memberAuthUids) }
          : {}),
      },
      { merge: true },
    );
  });
}

export async function readDeletionMemberUids(
  db: admin.firestore.Firestore,
  academyId: string,
): Promise<string[]> {
  const v = (await academyDeletionRef(db, academyId).get()).get("memberAuthUids");
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

/**
 * 학원 아래에 써도 되는지(B2) — 학원 문서가 있고 삭제 중이 아님. 한 번의 `getAll`.
 * 학원 삭제가 일으킨 트리거·늦은 요청이 지운 문서를 다시 만들지 않게 쓰기 직전에 확인한다.
 * (확인 직후 삭제가 시작되는 좁은 틈은 남음 — 학원 삭제의 마지막 쓸기·잔여 점검이 잡는다)
 */
export async function academyAcceptsWrites(db: admin.firestore.Firestore, academyId: string): Promise<boolean> {
  const [academy, deletion] = await db.getAll(db.doc(`academies/${academyId}`), academyDeletionRef(db, academyId));
  return academy.exists && !deletion.exists;
}
