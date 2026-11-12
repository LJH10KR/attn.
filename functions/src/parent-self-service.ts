import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { writeInfoBell } from "./lib/admin-inbox-info";
import { assertKrPhoneRequired } from "./lib/kr-phone";
import { autoLinkVerifiedParent } from "./lib/parent-auto-link";
import { parentDocRef, parentPhoneIndexRef, unlinkParentFromStudentTx } from "./lib/parent-links";
import {
  applyVerifiedParentPhone,
  confirmBellVariant,
  MSG_PARENT_PHONE_OTHER_ACCOUNT,
  MSG_PHONE_CHANGE_NEEDS_PROOF,
  MSG_PHONE_NOTICE_GONE,
  MSG_REVERT_NEEDS_VERIFIED,
  readPhoneNoticeEntry,
  syncLinkedGuardianPhone,
  writeParentPhoneBell,
} from "./lib/parent-phone-change";
import { readOptionalPhoneProof } from "./lib/phone-proof";
import { isAccountPhoneVerified } from "./lib/phone-verification";
import { deriveGuardianFields, readGuardians } from "./lib/student-guardians";

/**
 * 학부모 본인 동작(2-L) — "내 자녀가 아니에요"(L1-3), 학원 번호 변경 안내 창 처리(L3-1-2, `resolveParentPhoneNotice`).
 */

function requireParent(request: CallableRequest): { uid: string; academyId: string } {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const token = request.auth.token;
  const academyId = typeof token.academyId === "string" ? token.academyId : "";
  if (token.role !== "parent" || !academyId) {
    throw new HttpsError("permission-denied", "학부모 계정만 할 수 있습니다.");
  }
  return { uid: request.auth.uid, academyId };
}

export function declineBellId(parentUid: string, studentId: string): string {
  return `p-decline-${parentUid}-${studentId}`;
}

/**
 * "내 자녀가 아니에요" — 그 원생과의 연결만 풀고(보호자 연락처는 남김) 원장 벨. 학원 번호 오타 발견용이며,
 * 학부모가 자기 접근만 줄이므로 원장 확인 없이 바로 처리한다. 같은 원생에 다시 자동 연결되지 않게 표시한다(원장 직접 연결은 가능).
 */
export const declineParentChildLink = onCall(async (request) => {
  const { uid, academyId } = requireParent(request);
  const studentId = typeof request.data?.studentId === "string" ? request.data.studentId.trim() : "";
  if (!studentId || studentId.includes("/")) {
    throw new HttpsError("invalid-argument", "원생 정보가 올바르지 않습니다.");
  }
  const db = admin.firestore();
  const studentSnap = await db.doc(`academies/${academyId}/students/${studentId}`).get();
  const changed = await unlinkParentFromStudentTx(db, academyId, uid, studentId, { block: true });
  if (!changed) {
    throw new HttpsError("failed-precondition", "이미 연결이 해제된 자녀입니다.");
  }
  const parentSnap = await parentDocRef(db, academyId, uid).get();
  const displayName = typeof parentSnap.get("displayName") === "string" ? parentSnap.get("displayName") : "";
  await writeInfoBell(
    db,
    academyId,
    declineBellId(uid, studentId),
    {
      kind: "parent_child_declined",
      entityType: "parent",
      entityId: uid,
      displayName: displayName || "이름 미입력",
      studentId,
      studentName: typeof studentSnap.get("name") === "string" ? studentSnap.get("name") : "",
    },
    "replace",
  );
  return { ok: true as const };
});

function readStudentId(raw: unknown): string {
  const studentId = typeof raw === "string" ? raw.trim() : "";
  if (!studentId || studentId.includes("/") || studentId.includes(".")) {
    throw new HttpsError("invalid-argument", "원생 정보가 올바르지 않습니다.");
  }
  return studentId;
}

/**
 * 학원이 연결된 보호자 칸 번호를 바꾼 뒤 학부모 앱 안내 창(L3-1-2, `phoneNotice.byStudent.{studentId}`) 처리.
 * - `confirm`(지금 쓰는 번호 확인하기): 번호 확인 증표 필수. 확인된 번호가 최종값 — `applyVerifiedParentPhone`(계정·연결된 모든 칸·색인·안내 전체 정리),
 *   학원이 적은 번호와 다르면 벨 corrected(같으면 계정 번호가 바뀐 것이라 self), 그 뒤 ★8 자동 연결.
 * - `revert`(번호를 바꾸지 않았어요): 계정 번호가 이미 문자로 확인된 번호일 때만. 그 원생의 연결된 칸을 계정 번호로 되돌리고(★9 합치기) 벨 reverted.
 * App Check 없음 — 증표를 만들 때 이미 거침. [나중에]는 서버 호출 없음.
 */
export const resolveParentPhoneNotice = onCall(async (request) => {
  const { uid, academyId } = requireParent(request);
  const action = request.data?.action;
  const studentId = readStudentId(request.data?.studentId);
  const db = admin.firestore();

  if (action === "confirm") {
    const phone = assertKrPhoneRequired(request.data?.phone);
    const proof = readOptionalPhoneProof(request.data?.phoneProof);
    if (!proof) throw new HttpsError("failed-precondition", MSG_PHONE_CHANGE_NEEDS_PROOF);
    const applied = await applyVerifiedParentPhone(db, academyId, uid, { phone, rawProof: proof, noticeStudentId: studentId });
    const variant = confirmBellVariant(applied.notice!.phone, phone, applied.phoneChanged);
    if (variant) {
      await writeParentPhoneBell(
        db,
        academyId,
        uid,
        applied.displayName,
        variant,
        variant === "corrected" ? { id: studentId, name: applied.notice!.studentName } : undefined,
      ).catch((e) => logger.warn("resolveParentPhoneNotice: 원장 벨 실패(무시)", { academyId, e }));
    }
    const auto = await autoLinkVerifiedParent(db, academyId, uid);
    return { ok: true as const, action: "confirm" as const, phone, linkedCount: auto.linked.length };
  }

  if (action !== "revert") {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }
  const parentRef = parentDocRef(db, academyId, uid);
  const studentRef = db.doc(`academies/${academyId}/students/${studentId}`);
  const outcome = await db.runTransaction(async (tx) => {
    const [parentSnap, studentSnap] = await Promise.all([tx.get(parentRef), tx.get(studentRef)]);
    if (!parentSnap.exists) throw new HttpsError("not-found", "학부모 정보를 찾을 수 없습니다.");
    const notice = readPhoneNoticeEntry(parentSnap.get(`phoneNotice.byStudent.${studentId}`));
    if (!notice) throw new HttpsError("failed-precondition", MSG_PHONE_NOTICE_GONE);
    const data = parentSnap.data() ?? {};
    if (!isAccountPhoneVerified(data)) throw new HttpsError("failed-precondition", MSG_REVERT_NEEDS_VERIFIED);
    const accountPhone = data.phone as string;
    const idx = await tx.get(parentPhoneIndexRef(db, academyId, accountPhone));
    if (idx.exists && idx.get("parentUid") !== uid) {
      throw new HttpsError("failed-precondition", MSG_PARENT_PHONE_OTHER_ACCOUNT);
    }
    const clearNotice = () =>
      tx.update(parentRef, {
        [`phoneNotice.byStudent.${studentId}`]: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    const guardians = studentSnap.exists ? readGuardians(studentSnap.get("guardians")) : [];
    if (!guardians.some((g) => g.linkedParentUid === uid)) {
      // 그 사이 연결이 풀린 자녀 — 안내만 지움
      clearNotice();
      return { reverted: false, displayName: "", studentName: notice.studentName };
    }
    const linked = syncLinkedGuardianPhone(guardians, uid, accountPhone);
    if (linked.changed) {
      tx.update(studentRef, {
        guardians: linked.guardians,
        ...deriveGuardianFields(linked.guardians),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    clearNotice();
    return {
      reverted: true,
      displayName: typeof data.displayName === "string" ? data.displayName : "",
      studentName: typeof studentSnap.get("name") === "string" ? (studentSnap.get("name") as string) : notice.studentName,
    };
  });
  if (outcome.reverted) {
    await writeParentPhoneBell(db, academyId, uid, outcome.displayName, "reverted", {
      id: studentId,
      name: outcome.studentName,
    }).catch((e) => logger.warn("resolveParentPhoneNotice: 원장 벨 실패(무시)", { academyId, e }));
  }
  return { ok: true as const, action: "revert" as const, reverted: outcome.reverted };
});
