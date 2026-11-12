import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { stripTeacherFromClasses } from "./class-teachers";
import { deleteAttnLoginIndexForMember, deleteMemberLoginSecrets } from "./firestore-cleanup";
import { deleteParentAccountData } from "./parent-links";
import { detachStaffAccount } from "./staff-account";

/**
 * 학원 한 곳의 소속 정리(2-N) — 학원이 지우는 계정(`deleteTeacherInvite`·`deleteParentAccount`)과
 * 본인 탈퇴(`withdrawAccount`)가 같은 코드를 써서 결과(남는 것)가 같다(N11). Auth 판단은 호출 측.
 */

/** 써 오던 직원 계정(사용 중·비활성, 게스트 아님)은 인사 기록을 「계정 없음」 직원으로 남김 — 그 밖(대기·게스트)은 전체 삭제 */
export function keepsStaffHrRecord(status: unknown, isGuest: unknown, deleteHrRecord: boolean): boolean {
  return (status === "active" || status === "inactive") && isGuest !== true && !deleteHrRecord;
}

export type StaffRemoval =
  | { result: "missing" }
  | { result: "removed"; authUid: string; keptStaffId: string | null; hadStatus: string };

/**
 * 직원 계정 문서 정리 — 로그인 정보·색인 → 인사 기록 분리(또는 삭제) → 반 담당에서 빼기.
 * 반에서 빼는 일은 계정 문서를 분리·삭제한 **뒤**(그 사이 저장된 반도 새 uid 검사에서 막힘).
 * 다시 불러도 같은 결과(계정 문서가 이미 없으면 `missing` — 반 정리는 호출 측이 학원 목록으로 다시 할 수 있음).
 */
export async function removeStaffMembership(
  db: admin.firestore.Firestore,
  academyId: string,
  staffDocId: string,
  actorUid: string | null,
  opts: { deleteHrRecord: boolean },
): Promise<StaffRemoval> {
  const ref = db.doc(`academies/${academyId}/staff/${staffDocId}`);
  const snap = await ref.get();
  if (!snap.exists) return { result: "missing" };
  const data = snap.data() ?? {};
  const status = typeof data.status === "string" ? data.status : "";
  const authUid = typeof data.authUid === "string" && data.authUid ? data.authUid : staffDocId;
  const keep = keepsStaffHrRecord(status, data.isGuest, opts.deleteHrRecord);

  await deleteMemberLoginSecrets(db, academyId, "teacher", staffDocId);
  await deleteAttnLoginIndexForMember(db, data, authUid);
  const keptStaffId = keep ? await detachStaffAccount(db, academyId, ref) : null;
  if (!keep) await ref.delete();
  await stripTeacherFromClasses(db, academyId, authUid, actorUid);
  return { result: "removed", authUid, keptStaffId, hadStatus: status };
}

/** 학부모 계정 문서 정리(`deleteParentAccountData`) — 이미 없으면 `missing` */
export async function removeParentMembership(
  db: admin.firestore.Firestore,
  academyId: string,
  parentDocId: string,
): Promise<"removed" | "missing"> {
  try {
    await deleteParentAccountData(db, academyId, parentDocId);
    return "removed";
  } catch (e) {
    if (e instanceof HttpsError && e.code === "not-found") return "missing";
    throw e;
  }
}
