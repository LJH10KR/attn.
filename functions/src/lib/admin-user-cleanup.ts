import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { reconcileUserActivationMirror } from "../user-activation-mirror";
import { accountStillInUse } from "./account-use";
import { purgeUserFirestoreData } from "./firestore-cleanup";

/**
 * 계정(Auth)·사용자 데이터 정리 — 학원 삭제(원장·관리자·seed·잔여 정리)와 학원이 지우는 계정(학부모·직원·관리자 화면)이 함께 쓴다.
 * 관리자(admin 클레임) 계정은 Auth도 사용자 데이터도 지우지 않는다.
 * 2-N(★4·★5): 다른 쓰임(다른 학원 직원·학부모, 소유 학원, 원장 계정 표시)이 남은 계정은 Auth를 남긴다
 * — 지금까지는 학원 삭제·직원 계정 삭제가 무조건 지웠다.
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

/** Auth 사용자 삭제 — 이미 없으면 성공으로 본다. 그 밖의 오류는 던짐(호출 측 재시도로 이어서 끝나게) */
export async function deleteAuthUserIfExists(uid: string): Promise<void> {
  try {
    await admin.auth().deleteUser(uid);
  } catch (e) {
    if ((e as { code?: string }).code === "auth/user-not-found") return;
    throw e;
  }
}

export type AuthReleaseResult = "deleted" | "kept_in_use" | "kept_admin" | "skipped";

/**
 * 이 계정이 더는 쓰이지 않으면 Auth 삭제 + 사용자 데이터 정리. 쓰임이 남았으면 그대로 두고
 * 클레임·활성 미러를 남은 소속으로 다시 맞춘다(B4 — 지운 학원을 가리키지 않게. 멤버 문서 삭제 트리거도 같은 일을 한다).
 * Auth를 먼저 지운 뒤 사용자 데이터를 지운다 — 늦게 도는 미러 트리거는 Auth가 없으면 스스로 정리한다(F7).
 */
export async function releaseAuthIfUnused(
  db: admin.firestore.Firestore,
  uid: string,
  context: string,
  opts: { ignoreOwnerRole?: boolean } = {},
): Promise<AuthReleaseResult> {
  if (!uid || uid.includes("/") || uid.startsWith("academy_")) return "skipped";
  if (await authUserHasAdminClaim(uid)) {
    logger.warn(`${context}: skip admin auth user`, { uid });
    return "kept_admin";
  }
  if (await accountStillInUse(db, uid, opts)) {
    await reconcileUserActivationMirror(db, uid, "reconcile").catch((e) =>
      logger.warn(`${context}: 남긴 계정 미러 맞춤 실패(트리거가 다시 맞춤)`, { uid, e }),
    );
    logger.info(`${context}: account still in use — auth kept`, { uid });
    return "kept_in_use";
  }
  await deleteAuthUserIfExists(uid);
  await purgeUserFirestoreData(db, uid);
  return "deleted";
}

/**
 * 학원을 지운 뒤 그 학원 멤버 계정 정리 — 원장 uid는 건너뜀(원장은 `deleteAcademyCompletely`가 따로 판단).
 */
export async function releaseDeletedAcademyMembers(
  db: admin.firestore.Firestore,
  params: { memberAuthUids: Iterable<string>; ownerUid: string; context: string },
): Promise<Record<string, AuthReleaseResult>> {
  const out: Record<string, AuthReleaseResult> = {};
  for (const uid of new Set(params.memberAuthUids)) {
    if (!uid || uid === params.ownerUid) continue;
    out[uid] = await releaseAuthIfUnused(db, uid, params.context);
  }
  return out;
}
