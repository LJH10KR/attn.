import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

/**
 * 원장 벨 정보성 알림(2-L) — `academies/{a}/adminInbox/{id}`. 처리할 일이 아니라 "이런 일이 있었다" 알림이라
 * 30일 뒤 만료(`expiresAt`)하고, 새 알림을 쓸 때 만료된 것을 조금씩 지운다(단일 필드 조건 — 색인 불필요).
 * 문서 ID는 호출 측이 **결정값**으로 정한다 — 트리거 재시도·같은 요청 재시도에도 벨이 한 번만 생긴다
 * (`once`: create, 있으면 그대로 / `replace`: 같은 일이 다시 일어나면 새 시각으로 덮어씀).
 * 전화번호는 넣지 않는다(adminInbox 읽기 규칙이 `billing.payments`에도 열려 있음).
 */

export const INFO_BELL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH = 20;

export type InfoBellKind =
  | "parent_auto_linked"
  | "parent_child_declined"
  | "parent_phone_changed"
  | "staff_auto_activated"
  /** 2-M 아이디·비밀번호 찾기 — 문자 확인으로 비밀번호 재설정(학부모 `operations.parents`·직원 `settings.members`에 표시) */
  | "member_password_reset";

export async function writeInfoBell(
  db: admin.firestore.Firestore,
  academyId: string,
  id: string,
  data: {
    kind: InfoBellKind;
    entityType: "parent" | "teacher";
    entityId: string;
    displayName: string;
  } & Record<string, unknown>,
  mode: "once" | "replace" = "once",
  nowMs: number = Date.now(),
): Promise<boolean> {
  const col = db.collection(`academies/${academyId}/adminInbox`);
  let created = false;
  const doc = {
    schemaVersion: 1,
    email: "",
    ...data,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(nowMs + INFO_BELL_TTL_MS),
  };
  try {
    if (mode === "replace") await col.doc(id).set(doc);
    else await col.doc(id).create(doc);
    created = true;
  } catch (e) {
    // 이미 있음(재시도) — 그대로 둔다
    if ((e as { code?: number }).code !== 6) throw e;
  }
  try {
    const expired = await col.where("expiresAt", "<", Timestamp.fromMillis(nowMs)).limit(CLEANUP_BATCH).get();
    await Promise.all(expired.docs.map((d) => d.ref.delete()));
  } catch (e) {
    logger.warn("writeInfoBell: 만료 알림 정리 실패", { academyId, e });
  }
  return created;
}
