import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { writeInfoBell } from "./admin-inbox-info";
import { parentDocRef, parentPhoneIndexRef } from "./parent-links";
import { accountProofExpectation } from "./phone-proof";
import { readPhoneProofInTx, verifiedPhoneFields } from "./phone-verification";
import { deriveGuardianFields, guardianPhoneKey, readGuardians, type Guardian } from "./student-guardians";

/**
 * 학부모 번호 변경 재확인(2-L L-3, L3-1) — 원칙 "OCTOMO로 확인된 번호가 최종 정답".
 * - 학부모 본인 번호 변경(`updateParentProfile`)·학원 번호 변경 안내 확인(`resolveParentPhoneNotice` confirm)은
 *   모두 `applyVerifiedParentPhone` 한 트랜잭션: 증표 소비 · 계정 번호와 `phoneVerifiedKey`를 **함께** · 번호 색인 이동 ·
 *   연결된 모든 자녀 보호자 칸 번호(★9 같은 번호의 연결 안 된 칸 합치기) · `phoneNotice` 정리.
 * - 학원이 연결된 칸 번호를 바꾸면(`saveStudent`) 같은 트랜잭션에서 학부모 문서 `phoneNotice.byStudent.{studentId}`.
 * 벨에는 전화번호를 넣지 않는다.
 */

export const MSG_PARENT_PHONE_OTHER_ACCOUNT =
  "이 번호는 학원에 다른 학부모 계정으로 등록되어 있어요. 학원에 문의해 주세요.";
export const MSG_PHONE_CHANGE_NEEDS_PROOF = "번호를 바꾸려면 새 번호로 문자 확인을 해 주세요.";
export const MSG_PHONE_NOTICE_GONE = "이미 처리된 안내입니다.";
export const MSG_REVERT_NEEDS_VERIFIED =
  "지금 계정 번호가 문자로 확인된 번호일 때만 되돌릴 수 있어요. 「지금 쓰는 번호 확인하기」를 눌러 주세요.";

export type PhoneNoticeEntry = { studentName: string; phone: string };

/** `phoneNotice.byStudent.{id}` 한 항목 — 형식이 어긋나면 null */
export function readPhoneNoticeEntry(raw: unknown): PhoneNoticeEntry | null {
  const r = raw as Record<string, unknown> | null | undefined;
  if (!r || typeof r.phone !== "string" || !r.phone) return null;
  return { studentName: typeof r.studentName === "string" ? r.studentName : "", phone: r.phone };
}

/**
 * ★9 — 연결된 칸(`linkedParentUid === uid`)의 번호를 `phone`으로 바꾸고, 같은 원생에 그 번호의 **연결 안 된** 칸이 있으면 합친다:
 * 중복 칸 삭제, 연결된 칸의 관계·이름이 비었으면 중복 칸 값으로 채움, 중복 칸이 대표였으면 대표를 넘김.
 * 그 번호 칸이 다른 계정에 연결돼 있으면 거부(색인 검사에서 먼저 막히므로 보통 생기지 않음).
 * 연결된 칸이 없으면 그대로(`changed: false`).
 */
export function syncLinkedGuardianPhone(
  guardians: readonly Guardian[],
  uid: string,
  phone: string,
): { guardians: Guardian[]; changed: boolean } {
  const idx = guardians.findIndex((g) => g.linkedParentUid === uid);
  if (idx < 0) return { guardians: [...guardians], changed: false };
  const key = guardianPhoneKey(phone);
  const before = guardians[idx]!;
  const linked: Guardian = { ...before, phone };
  let changed = before.phone !== phone;
  for (const [i, g] of guardians.entries()) {
    if (i === idx || guardianPhoneKey(g.phone) !== key) continue;
    if (g.linkedParentUid) {
      throw new HttpsError("failed-precondition", MSG_PARENT_PHONE_OTHER_ACCOUNT);
    }
    if (!linked.relationId && g.relationId) linked.relationId = g.relationId;
    if (!linked.name && g.name) linked.name = g.name;
    if (g.isPrimary) linked.isPrimary = true;
    changed = true;
  }
  const next = guardians.flatMap((g, i) =>
    i === idx ? [linked] : guardianPhoneKey(g.phone) === key ? [] : [g],
  );
  return { guardians: next, changed };
}

/** 학원이 연결된 칸 번호를 바꿨을 때 — 계정 번호와 같아졌으면 안내 항목 삭제, 아니면 안내 */
export function phoneNoticeActionFor(accountPhone: unknown, slotPhone: string): "clear" | "set" {
  const account = guardianPhoneKey(typeof accountPhone === "string" ? accountPhone : "");
  return account !== "" && account === guardianPhoneKey(slotPhone) ? "clear" : "set";
}

/** `saveStudent` — 연결된 칸 중 번호가 바뀐 것(같은 칸 id·같은 계정) */
export function changedLinkedGuardianPhones(
  before: readonly Guardian[],
  after: readonly Guardian[],
): { uid: string; phone: string }[] {
  const byId = new Map(before.map((g) => [g.id, g]));
  return after.flatMap((g) => {
    if (!g.linkedParentUid) return [];
    const prev = byId.get(g.id);
    if (!prev || prev.linkedParentUid !== g.linkedParentUid) return [];
    return guardianPhoneKey(prev.phone) === guardianPhoneKey(g.phone) ? [] : [{ uid: g.linkedParentUid, phone: g.phone }];
  });
}

/** 안내 창 [지금 쓰는 번호 확인하기] 뒤 벨 — 학원이 적은 번호와 다르면 corrected, 같으면(계정 번호가 바뀜) self */
export function confirmBellVariant(noticePhone: string, confirmedPhone: string, phoneChanged: boolean): "corrected" | "self" | null {
  if (guardianPhoneKey(noticePhone) !== guardianPhoneKey(confirmedPhone)) return "corrected";
  return phoneChanged ? "self" : null;
}

export type ParentPhoneBellVariant = "self" | "corrected" | "reverted";

/** 벨 ID — 본인 변경은 학부모당 1개(새 변경이 덮어씀), 안내 처리는 학부모·원생마다 */
export function parentPhoneBellId(uid: string, variant: ParentPhoneBellVariant, studentId?: string): string {
  return variant === "self" ? `p-phone-${uid}` : `p-phone-${variant}-${uid}-${studentId ?? ""}`;
}

export async function writeParentPhoneBell(
  db: admin.firestore.Firestore,
  academyId: string,
  uid: string,
  displayName: string,
  variant: ParentPhoneBellVariant,
  student?: { id: string; name: string },
): Promise<void> {
  await writeInfoBell(
    db,
    academyId,
    parentPhoneBellId(uid, variant, student?.id),
    {
      kind: "parent_phone_changed",
      entityType: "parent",
      entityId: uid,
      displayName: displayName || "이름 미입력",
      variant,
      ...(student ? { studentId: student.id, studentName: student.name } : {}),
    },
    "replace",
  );
}

export type AppliedParentPhone = {
  /** 계정 번호가 바뀌었는지(숫자 기준) */
  phoneChanged: boolean;
  displayName: string;
  /** confirm일 때 처리한 안내 항목 */
  notice: PhoneNoticeEntry | null;
  /** 번호를 바꾼 연결 자녀 */
  syncedStudentIds: string[];
};

/**
 * 문자로 확인된 번호를 계정에 적용(한 트랜잭션) — 계정 번호·`phoneVerifiedKey`/`phoneVerifiedAt`(함께), 번호 색인 이동,
 * 연결된 모든 자녀 보호자 칸(★9 합치기), `phoneNotice` 전체 삭제, 증표 소비.
 * 새 번호의 색인을 다른 계정이 잡고 있으면 거부. `noticeStudentId`(안내 창 confirm)는 그 안내 항목이 있어야 한다.
 * 벨·자동 연결(★8)은 호출 측이 커밋 뒤에.
 */
export async function applyVerifiedParentPhone(
  db: admin.firestore.Firestore,
  academyId: string,
  uid: string,
  input: { phone: string; rawProof: string; displayName?: string; noticeStudentId?: string },
): Promise<AppliedParentPhone> {
  const ref = parentDocRef(db, academyId, uid);
  const expect = accountProofExpectation(uid, input.phone);
  const newIndexRef = parentPhoneIndexRef(db, academyId, input.phone);
  const linkedQuery = db.collection(`academies/${academyId}/students`).where("parentUids", "array-contains", uid);

  return db.runTransaction(async (tx) => {
    const proof = await readPhoneProofInTx(tx, db, input.rawProof, expect);
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError("not-found", "학부모 정보를 찾을 수 없습니다.");
    }
    let notice: PhoneNoticeEntry | null = null;
    if (input.noticeStudentId) {
      notice = readPhoneNoticeEntry(snap.get(`phoneNotice.byStudent.${input.noticeStudentId}`));
      if (!notice) throw new HttpsError("failed-precondition", MSG_PHONE_NOTICE_GONE);
    }
    const oldPhone = typeof snap.get("phone") === "string" ? (snap.get("phone") as string) : "";
    const oldKey = guardianPhoneKey(oldPhone);
    const phoneChanged = oldKey !== guardianPhoneKey(input.phone);
    const oldIndexRef = phoneChanged && oldKey ? parentPhoneIndexRef(db, academyId, oldPhone) : null;
    const [newIdx, oldIdx, linked] = await Promise.all([
      tx.get(newIndexRef),
      oldIndexRef ? tx.get(oldIndexRef) : Promise.resolve(null),
      tx.get(linkedQuery),
    ]);
    if (newIdx.exists && newIdx.get("parentUid") !== uid) {
      throw new HttpsError("failed-precondition", MSG_PARENT_PHONE_OTHER_ACCOUNT);
    }
    const studentWrites: { ref: admin.firestore.DocumentReference; guardians: Guardian[] }[] = [];
    for (const s of linked.docs) {
      const r = syncLinkedGuardianPhone(readGuardians(s.get("guardians")), uid, input.phone);
      if (r.changed) studentWrites.push({ ref: s.ref, guardians: r.guardians });
    }

    // 쓰기 — 색인: 옛 번호 색인을 이 계정이 잡았으면 새 번호로 옮김(연결된 계정은 지금 번호 색인을 항상 가짐)
    const holdsOld = Boolean(oldIdx?.exists && oldIdx.get("parentUid") === uid);
    if (holdsOld && oldIndexRef) tx.delete(oldIndexRef);
    if (!newIdx.exists && (holdsOld || !linked.empty)) {
      tx.set(newIndexRef, { parentUid: uid, createdAt: FieldValue.serverTimestamp() });
    }
    tx.update(ref, {
      phone: input.phone,
      ...verifiedPhoneFields(proof.phoneKey),
      phoneNotice: FieldValue.delete(),
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    for (const w of studentWrites) {
      tx.update(w.ref, {
        guardians: w.guardians,
        ...deriveGuardianFields(w.guardians),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    proof.markUsed(uid);
    const name = input.displayName ?? (typeof snap.get("displayName") === "string" ? (snap.get("displayName") as string) : "");
    return {
      phoneChanged,
      displayName: name,
      notice,
      syncedStudentIds: studentWrites.map((w) => w.ref.id),
    };
  });
}
