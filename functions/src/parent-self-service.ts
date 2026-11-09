import * as admin from "firebase-admin";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { writeInfoBell } from "./lib/admin-inbox-info";
import { parentDocRef, unlinkParentFromStudentTx } from "./lib/parent-links";

/**
 * 학부모 본인 동작(2-L) — "내 자녀가 아니에요"(L1-3). 번호 변경 안내 창 처리(L3-1-2)는 L-3에서 이 파일에 더한다.
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
