import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { academyDeletionRef } from "./lib/academy-deletion-state";
import { deleteAcademyCompletely } from "./lib/academy-delete";
import { assertRecentAuth } from "./lib/recent-auth";

/**
 * 원장 학원 삭제(2-N N6~N8) — 관리자 삭제와 같은 전체 정리(`deleteAcademyCompletely`, 결제 기록 포함, 즉시 파기).
 * 확인: 학원 이름 입력(`confirmName`, 앞뒤 공백 제외 일치) + 최근 인증 5분(★1). 원장 계정은 남긴다(★3 — 탈퇴는 따로).
 * 중간에 멈추면 같은 호출로 이어서 끝난다 — 학원 문서가 이미 없고 이 원장의 삭제 표시만 남았으면 이어서 마무리.
 */

const MSG_NAME_MISMATCH = "학원 이름이 맞지 않아요. 다시 입력해 주세요.";

/**
 * 기존 문서 경로용 — Firestore 문서 ID는 대소문자를 구분하므로 소문자 강제 없음.
 * (예전 addDoc 자동 ID·혼합 대소문자 ID와 호환)
 */
function requireAcademyDocumentId(raw: unknown): string {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) {
    throw new HttpsError("invalid-argument", "학원 ID를 입력해 주세요.");
  }
  if (id.includes("/") || id.length > 800) {
    throw new HttpsError("invalid-argument", "유효하지 않은 학원 ID입니다.");
  }
  return id;
}

export const deleteOwnerAcademy = onCall({ timeoutSeconds: 540 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireAcademyDocumentId(request.data?.academyId);
  const confirmName = typeof request.data?.confirmName === "string" ? request.data.confirmName.trim() : "";

  const db = admin.firestore();
  const [academySnap, deletionSnap] = await db.getAll(db.doc(`academies/${academyId}`), academyDeletionRef(db, academyId));
  if (academySnap.exists) {
    if (academySnap.get("ownerUid") !== uid) {
      throw new HttpsError("permission-denied", "학원을 삭제할 권한이 없습니다.");
    }
    const name = typeof academySnap.get("name") === "string" ? (academySnap.get("name") as string).trim() : "";
    if (!confirmName || confirmName !== name) {
      throw new HttpsError("invalid-argument", MSG_NAME_MISMATCH, { reason: "name_mismatch" });
    }
  } else if (!(deletionSnap.exists && deletionSnap.get("ownerUid") === uid)) {
    throw new HttpsError("not-found", "학원을 찾을 수 없습니다.");
  }
  await assertRecentAuth(request);

  await deleteAcademyCompletely(db, academyId, {
    ownerAccount: "keep",
    context: "deleteOwnerAcademy",
    requestedBy: uid,
    ownerUidHint: uid,
  });
  return { ok: true as const };
});
