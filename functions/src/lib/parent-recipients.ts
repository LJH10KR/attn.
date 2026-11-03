import type * as admin from "firebase-admin";

/**
 * 학부모 푸시·벨 수신자 — 학생 `parentUids` 중 학부모 계정(`parents/{uid}`)이 `active`인 계정만.
 * `parentUids`는 보호자 연결로만 정해지므로, 비활성화·첫 로그인 전·승인 대기 계정을 여기서 거른다.
 * 출결·원비·회차·결제 완료·키오스크 PIN 안내 등 학부모에게 보내는 모든 알림이 이 함수를 거친다.
 */
export async function resolveParentRecipients(
  db: admin.firestore.Firestore,
  academyId: string,
  parentUids: unknown,
): Promise<string[]> {
  const uids = readUidList(parentUids);
  if (uids.length === 0) return [];
  const snaps = await db.getAll(...uids.map((uid) => db.doc(`academies/${academyId}/parents/${uid}`)));
  return uids.filter((_, i) => snaps[i]?.exists && snaps[i]!.get("status") === "active");
}

/** 문서의 uid 배열 필드(`parentUids` 등) — 문자열만, 중복 제거 */
export function readUidList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x): x is string => typeof x === "string" && x.length > 0))];
}
