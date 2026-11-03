import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { purgeUserFirestoreData } from "./firestore-cleanup";

/**
 * 관리자 화면의 학원·계정 삭제가 함께 쓰는 Auth·사용자 데이터 정리.
 * 관리자(admin 클레임) 계정은 Auth도 사용자 데이터도 지우지 않는다.
 */

export async function authUserHasAdminClaim(uid: string): Promise<boolean> {
  try {
    const u = await admin.auth().getUser(uid);
    const c = u.customClaims as Record<string, unknown> | undefined;
    return Boolean(c && c.admin === true);
  } catch {
    return false;
  }
}

export async function safeDeleteAuthUser(uid: string, context: string): Promise<void> {
  if (!uid || uid.startsWith("academy_")) return;
  if (await authUserHasAdminClaim(uid)) {
    logger.warn(`${context}: skip admin auth user`, { uid });
    return;
  }
  try {
    await admin.auth().deleteUser(uid);
  } catch (e) {
    logger.warn(`${context}: deleteUser skipped`, { uid, e });
  }
}

/**
 * 학원을 지운 뒤 그 학원의 계정 정리 — 멤버 계정은 Auth 삭제 + 사용자 데이터 정리(admin 제외).
 * 원장은 남은 소유 학원이 없고 admin이 아닐 때만 Auth 삭제·사용자 데이터 정리
 * (학원을 여러 개 가진 원장의 학원 하나를 지워도 로그인 계정은 남는다).
 */
export async function cleanupDeletedAcademyUsers(
  db: admin.firestore.Firestore,
  params: { memberAuthUids: Iterable<string>; ownerUid: string; context: string },
): Promise<void> {
  const { ownerUid, context } = params;
  for (const uid of new Set(params.memberAuthUids)) {
    if (!uid || uid === ownerUid) continue;
    await safeDeleteAuthUser(uid, context);
    if (!(await authUserHasAdminClaim(uid))) {
      await purgeUserFirestoreData(db, uid);
    }
  }
  if (!ownerUid) return;
  const remainingOwned = await db.collection("academies").where("ownerUid", "==", ownerUid).limit(1).get();
  if (!remainingOwned.empty) {
    logger.info(`${context}: owner keeps other academies — auth kept`, { ownerUid });
    return;
  }
  if (await authUserHasAdminClaim(ownerUid)) return;
  await safeDeleteAuthUser(ownerUid, context);
  await purgeUserFirestoreData(db, ownerUid);
}
