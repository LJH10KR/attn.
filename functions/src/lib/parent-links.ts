import * as admin from "firebase-admin";
import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { deleteAttnLoginIndexForMember, deleteMemberLoginSecrets } from "./firestore-cleanup";
import { readUidList } from "./parent-recipients";
import {
  deriveGuardianFields,
  guardianPhoneKey,
  MAX_GUARDIANS,
  newGuardianId,
  readGuardians,
} from "./student-guardians";

/**
 * 학부모 앱 계정 ↔ 원생 보호자 연결.
 * - 연결의 원본은 학생 `guardians[].linkedParentUid`이고, `parentUids`는 같은 쓰기에서 `deriveGuardianFields`로 함께 쓴다.
 * - 연결·해제는 학생마다 트랜잭션(학생 문서를 안에서 읽음).
 * - 학부모 요약(`linkedStudentIds`·`pending_approval ↔ active`)과 결제 `parentUids`는 학생 트리거
 *   (`onAcademyStudentParentLinksWritten`)가 "현재 값에 맞추기"로 처리한다 — 연결·해제·계정 삭제 모든 경로 공통.
 * - 같은 학원에서 번호 1개 = 연결된 계정 1개: `parentPhones/{숫자}` 색인을 첫 연결·직접 만들기 때 잡는다(가입 때는 잡지 않음).
 */

export type ParentAccountStatus =
  | "pending_email_verification"
  | "pending_setup"
  | "pending_approval"
  | "active"
  | "inactive";

export const PARENT_PHONE_TAKEN_MSG = "이 번호는 이미 다른 학부모 계정에 연결되어 있습니다.";

/** 연결 자녀 수로 정하는 사용 가능 상태 — 0명이면 승인 대기·연결 대기 */
export function parentStatusFromLinks(linkedCount: number): "pending_approval" | "active" {
  return linkedCount > 0 ? "active" : "pending_approval";
}

/** 연결 자녀 수에 따라 서버가 자동으로 바꾸는 상태(인증 전·첫 로그인 전·비활성은 그대로) */
export function isAutoLinkStatus(status: unknown): status is "pending_approval" | "active" {
  return status === "pending_approval" || status === "active";
}

/**
 * 연결할 수 있는 계정 상태 — 이메일 인증 전(인증 없이 만들 수 있는 계정)·비활성은 거부.
 * 위반이면 안내 문구, 통과면 null.
 */
export function parentLinkTargetViolation(status: unknown): string | null {
  if (status === "pending_approval" || status === "active" || status === "pending_setup") return null;
  if (status === "pending_email_verification") {
    return "이메일 인증을 마치지 않은 계정은 연결할 수 없습니다. 학부모가 로그인해 인증을 마친 뒤 연결해 주세요.";
  }
  if (status === "inactive") return "비활성 계정은 다시 활성화한 뒤 연결해 주세요.";
  return "연결할 수 없는 계정 상태입니다.";
}

export function parentDocRef(db: admin.firestore.Firestore, academyId: string, uid: string) {
  return db.doc(`academies/${academyId}/parents/${uid}`);
}

export function parentPhoneIndexRef(db: admin.firestore.Firestore, academyId: string, phone: string) {
  const key = guardianPhoneKey(phone);
  if (!key) {
    throw new HttpsError("failed-precondition", "계정에 휴대폰 번호가 없습니다.");
  }
  return db.doc(`academies/${academyId}/parentPhones/${key}`);
}

function linkedStudentsQuery(db: admin.firestore.Firestore, academyId: string, uid: string) {
  return db.collection(`academies/${academyId}/students`).where("parentUids", "array-contains", uid);
}

/** 트랜잭션 안에서 연결 자녀 id 목록(정렬) — 상태 전환을 같은 트랜잭션의 학부모 문서와 함께 정할 때 */
export async function readLinkedStudentIdsInTx(
  tx: Transaction,
  db: admin.firestore.Firestore,
  academyId: string,
  uid: string,
): Promise<string[]> {
  const snap = await tx.get(linkedStudentsQuery(db, academyId, uid));
  return snap.docs.map((d) => d.id).sort();
}

/**
 * 번호 색인 확인·생성(트랜잭션 안, 읽기 단계에서 부를 것). 다른 계정이 잡고 있으면 거부, 같은 계정이면 그대로.
 * 반환된 함수는 쓰기 단계에서 호출한다(색인이 없을 때만 생성, 새로 만들었으면 true).
 */
export async function claimParentPhoneIndexInTx(
  tx: Transaction,
  db: admin.firestore.Firestore,
  academyId: string,
  phone: string,
  uid: string,
): Promise<() => boolean> {
  const ref = parentPhoneIndexRef(db, academyId, phone);
  const snap = await tx.get(ref);
  if (snap.exists && snap.get("parentUid") !== uid) {
    throw new HttpsError("already-exists", PARENT_PHONE_TAKEN_MSG);
  }
  return () => {
    if (snap.exists) return false;
    tx.set(ref, { parentUid: uid, createdAt: FieldValue.serverTimestamp() });
    return true;
  };
}

/**
 * 이번 연결 요청에서 새로 잡은 색인을 되돌린다(연결이 하나도 안 됐을 때). 색인이 이 계정 것이고
 * 연결된 학생이 0명일 때만 지운다 — 같은 계정의 다른 연결 요청이 그 사이 연결했으면 그대로 둔다.
 */
export async function releaseUnusedParentPhoneIndex(
  db: admin.firestore.Firestore,
  academyId: string,
  phone: string,
  uid: string,
): Promise<boolean> {
  const ref = parentPhoneIndexRef(db, academyId, phone);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get("parentUid") !== uid) return false;
    const linked = await tx.get(linkedStudentsQuery(db, academyId, uid).limit(1));
    if (!linked.empty) return false;
    tx.delete(ref);
    return true;
  });
}

export type LinkTarget = { uid: string; phone: string; displayName: string };

/** 연결하는 사이 학부모 계정 번호가 바뀌었을 때 */
export const PARENT_ACCOUNT_CHANGED_MSG = "계정 정보가 바뀌었습니다. 다시 시도해 주세요.";

/**
 * 학생 1명에 계정 연결(트랜잭션). 번호가 같은 보호자 항목에 연결하고, 없으면(원장이 직접 고른 원생)
 * 계정 이름·번호로 보호자 항목을 추가한다. 이미 연결돼 있으면 "already".
 * 같은 트랜잭션에서 번호 색인도 확인한다(다른 계정이 잡았으면 거부, 없으면 다시 잡음) —
 * 같은 계정의 다른 요청이 색인을 되돌리는 것과 겹쳐도 색인 없는 연결이 생기지 않게.
 * 학부모 문서도 같은 트랜잭션에서 다시 읽는다(존재·상태·번호) — 호출 측이 트랜잭션 밖에서 읽은 번호(`target.phone`)가
 * 그 사이 `updateParentProfile`로 바뀌었으면 거부해, 옛 번호 색인이 다시 생기거나 옛 번호로 연결되지 않게 한다.
 */
export async function linkParentToStudentTx(
  db: admin.firestore.Firestore,
  academyId: string,
  target: LinkTarget,
  studentId: string,
): Promise<"linked" | "already"> {
  const ref = db.doc(`academies/${academyId}/students/${studentId}`);
  const key = guardianPhoneKey(target.phone);
  return db.runTransaction(async (tx) => {
    const [snap, parentSnap] = await Promise.all([
      tx.get(ref),
      tx.get(parentDocRef(db, academyId, target.uid)),
    ]);
    if (!parentSnap.exists) {
      throw new HttpsError("not-found", "학부모 계정을 찾을 수 없습니다.");
    }
    const violation = parentLinkTargetViolation(parentSnap.get("status"));
    if (violation) {
      throw new HttpsError("failed-precondition", violation);
    }
    const currentPhone = parentSnap.get("phone");
    if (!key || guardianPhoneKey(typeof currentPhone === "string" ? currentPhone : "") !== key) {
      throw new HttpsError("failed-precondition", PARENT_ACCOUNT_CHANGED_MSG);
    }
    if (!snap.exists) {
      throw new HttpsError("not-found", "원생 정보를 찾을 수 없습니다.");
    }
    const guardians = readGuardians(snap.get("guardians"));
    if (guardians.some((g) => g.linkedParentUid === target.uid)) return "already";
    const writeIndex = await claimParentPhoneIndexInTx(tx, db, academyId, target.phone, target.uid);

    const idx = guardians.findIndex((g) => guardianPhoneKey(g.phone) === key);
    if (idx >= 0) {
      if (guardians[idx]!.linkedParentUid) {
        throw new HttpsError(
          "failed-precondition",
          "이 원생의 같은 번호 보호자는 이미 다른 계정에 연결되어 있습니다.",
        );
      }
      guardians[idx] = { ...guardians[idx]!, linkedParentUid: target.uid };
    } else {
      if (guardians.length >= MAX_GUARDIANS) {
        throw new HttpsError(
          "failed-precondition",
          `보호자가 이미 ${MAX_GUARDIANS}명이라 연결할 수 없습니다. 원생 정보에서 보호자를 정리해 주세요.`,
        );
      }
      guardians.push({
        id: newGuardianId(),
        relationId: null,
        name: target.displayName.slice(0, 30) || null,
        phone: target.phone,
        isPrimary: guardians.length === 0,
        linkedParentUid: target.uid,
      });
    }
    writeIndex();
    tx.update(ref, {
      guardians,
      ...deriveGuardianFields(guardians),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return "linked";
  });
}

/** 학생 1명에서 계정 연결만 지움(보호자 연락처는 남김, 트랜잭션). 바뀌었으면 true */
export async function unlinkParentFromStudentTx(
  db: admin.firestore.Firestore,
  academyId: string,
  uid: string,
  studentId: string,
): Promise<boolean> {
  const ref = db.doc(`academies/${academyId}/students/${studentId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const before = readGuardians(snap.get("guardians"));
    if (!before.some((g) => g.linkedParentUid === uid)) return false;
    const guardians = before.map((g) => (g.linkedParentUid === uid ? { ...g, linkedParentUid: null } : g));
    tx.update(ref, {
      guardians,
      ...deriveGuardianFields(guardians),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

function sameList(a: unknown, b: readonly string[]): boolean {
  const list = readUidList(a).sort();
  return list.length === b.length && list.every((x, i) => x === b[i]);
}

/**
 * 학부모 요약을 현재 연결에 맞춘다(트리거, 트랜잭션) — 여러 번 실행해도 결과가 같다.
 * 학부모 문서가 있을 때만 update(지운 계정 문서를 되살리지 않게). 자동 전환은 `pending_approval`·`active`만,
 * 그 사이 비활성 등으로 바뀌었으면 상태는 건드리지 않는다.
 */
export async function refreshParentLinkSummary(
  db: admin.firestore.Firestore,
  academyId: string,
  uid: string,
): Promise<void> {
  const ref = parentDocRef(db, academyId, uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const ids = await readLinkedStudentIdsInTx(tx, db, academyId, uid);
    const patch: Record<string, unknown> = {};
    if (!sameList(snap.get("linkedStudentIds"), ids)) patch.linkedStudentIds = ids;
    const status = snap.get("status");
    if (isAutoLinkStatus(status)) {
      const next = parentStatusFromLinks(ids.length);
      if (next !== status) {
        patch.status = next;
        if (next === "active" && !snap.get("activatedAt")) patch.activatedAt = FieldValue.serverTimestamp();
      }
    }
    if (Object.keys(patch).length === 0) return;
    tx.update(ref, { ...patch, updatedAt: FieldValue.serverTimestamp() });
  });
}

/**
 * 학생 결제 문서의 `parentUids`를 학생의 현재 `parentUids`에 맞춘다(트랜잭션) — 여러 번 실행해도 결과가 같다.
 * 학생이 삭제됐으면 건드리지 않는다(실제로 낸 납부 기록이라 마지막 값을 그대로 남김).
 */
export async function syncStudentPaymentParents(
  db: admin.firestore.Firestore,
  academyId: string,
  studentId: string,
): Promise<number> {
  const studentRef = db.doc(`academies/${academyId}/students/${studentId}`);
  const paymentsQuery = db
    .collection(`academies/${academyId}/payments`)
    .where("studentId", "==", studentId);
  return db.runTransaction(async (tx) => {
    const studentSnap = await tx.get(studentRef);
    if (!studentSnap.exists) return 0;
    const target = readUidList(studentSnap.get("parentUids")).sort();
    const payments = await tx.get(paymentsQuery);
    let changed = 0;
    for (const p of payments.docs) {
      if (sameList(p.get("parentUids"), target)) continue;
      tx.update(p.ref, { parentUids: target });
      changed += 1;
    }
    return changed;
  });
}

/**
 * 학부모 계정 데이터 삭제(가입 거절·계정 삭제·관리자 삭제 공통) — 원생은 그대로 두고 연결만 해제,
 * 번호 색인(이 계정이 잡은 것만)·로그인 정보·계정 문서 삭제. Auth 삭제는 호출 측에서.
 */
export async function deleteParentAccountData(
  db: admin.firestore.Firestore,
  academyId: string,
  uid: string,
): Promise<{ authUid: string; data: FirebaseFirestore.DocumentData }> {
  const ref = parentDocRef(db, academyId, uid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "학부모 계정을 찾을 수 없습니다.");
  }
  const data = snap.data() ?? {};
  const authUid = typeof data.authUid === "string" && data.authUid ? data.authUid : uid;

  const linked = await linkedStudentsQuery(db, academyId, uid).get();
  for (const s of linked.docs) {
    await unlinkParentFromStudentTx(db, academyId, uid, s.id);
  }

  if (typeof data.phone === "string" && guardianPhoneKey(data.phone)) {
    const indexRef = parentPhoneIndexRef(db, academyId, data.phone);
    await db.runTransaction(async (tx) => {
      const idx = await tx.get(indexRef);
      if (idx.exists && idx.get("parentUid") === uid) tx.delete(indexRef);
    });
  }

  await deleteMemberLoginSecrets(db, academyId, "parent", uid);
  await deleteAttnLoginIndexForMember(db, data, authUid);
  await ref.delete();
  return { authUid, data };
}

/** 다른 학원 멤버십·소유 학원이 남아 있는 Auth 계정인지(학부모 계정을 지울 때 Auth까지 지울지 판단) */
export async function authUidHasOtherMemberships(
  db: admin.firestore.Firestore,
  authUid: string,
): Promise<boolean> {
  const [staff, parents, owned] = await Promise.all([
    db.collectionGroup("staff").where("authUid", "==", authUid).limit(1).get(),
    db.collectionGroup("parents").where("authUid", "==", authUid).limit(1).get(),
    db.collection("academies").where("ownerUid", "==", authUid).limit(1).get(),
  ]);
  return !staff.empty || !parents.empty || !owned.empty;
}
