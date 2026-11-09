import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { writeInfoBell } from "./admin-inbox-info";
import { linkParentToStudentTx, parentDocRef, parentPhoneIndexRef, refreshParentLinkSummary } from "./parent-links";
import { isAccountPhoneVerified } from "./phone-verification";

/**
 * 번호 확인된 학부모 자동 연결(2-L, L1) — OCTOMO로 번호가 확인된 계정을, 학원이 적은 보호자 번호가 같은 원생(형제 포함)과 연결.
 * 시점: ① 가입할 때 ② 학부모 본인 번호 변경이 확인될 때(매번, ★8) ③ 학원이 원생·보호자 번호를 넣거나 바꿀 때(학생 트리거, ★3).
 * 조건(모두): 학원 설정 켜짐(기본) · 계정 상태 승인 대기/사용 중 · 계정 번호 = 확인된 번호 ·
 * 그 번호의 후보 계정이 정확히 1개(색인을 다른 계정이 잡지 않았고, 같은 번호로 확인한 다른 대기·사용 중 계정 없음, ★7) ·
 * 원생이 퇴원이 아니고 · 같은 번호의 **빈** 보호자 칸이 있고 · 차단 표시(원장 해제·"내 자녀가 아니에요", ★5)가 없음.
 * 원생마다 트랜잭션(`linkParentToStudentTx` auto)이 조건을 다시 확인한다. 연결되면 원생마다 원장 벨 1건(결정 ID).
 */

export const AUTO_LINK_ACCOUNT_STATUSES = ["pending_approval", "active"] as const;
const MAX_AUTO_LINK_STUDENTS = 20;

export function parentLinkSettingsRef(db: admin.firestore.Firestore, academyId: string) {
  return db.doc(`academies/${academyId}/meta/parentLinkSettings`);
}

/** 학원 설정 "번호 확인된 학부모 자동 연결" — 값이 없으면 켜짐(기본) */
export async function readAutoLinkEnabled(db: admin.firestore.Firestore, academyId: string): Promise<boolean> {
  const snap = await parentLinkSettingsRef(db, academyId).get();
  return snap.get("autoLinkVerifiedParents") !== false;
}

export function isAutoLinkAccountStatus(status: unknown): boolean {
  return (AUTO_LINK_ACCOUNT_STATUSES as readonly unknown[]).includes(status);
}

/**
 * 후보 판단(★7) — 번호 색인을 다른 계정이 잡았거나, 같은 번호로 확인한 다른 대기·사용 중 계정이 있으면 자동 연결하지 않는다.
 * `otherVerifiedStatuses`: 같은 `phoneVerifiedKey`를 가진 **다른** 계정들의 상태.
 */
export function autoLinkCandidateReason(params: {
  parentUid: string;
  indexHolderUid: string | null;
  otherVerifiedStatuses: readonly unknown[];
}): "ok" | "index_taken" | "ambiguous" {
  if (params.indexHolderUid && params.indexHolderUid !== params.parentUid) return "index_taken";
  if (params.otherVerifiedStatuses.some(isAutoLinkAccountStatus)) return "ambiguous";
  return "ok";
}

export function autoLinkBellId(parentUid: string, studentId: string): string {
  return `p-autolink-${parentUid}-${studentId}`;
}

export type AutoLinkResult = {
  linked: { id: string; name: string }[];
  reason: "linked" | "none" | "off" | "not_verified" | "status" | "index_taken" | "ambiguous";
};

/**
 * 한 학부모 계정을 자동 연결 — `studentIds`가 있으면 그 원생만(학생 트리거), 없으면 그 번호의 원생 모두(가입·번호 변경).
 * 실패해도 던지지 않는다(가입·번호 변경 자체는 이미 끝남) — 일시 오류는 학생 트리거만 다시 던져 재시도한다.
 */
export async function autoLinkVerifiedParent(
  db: admin.firestore.Firestore,
  academyId: string,
  parentUid: string,
  opts: { studentIds?: readonly string[]; throwOnError?: boolean } = {},
): Promise<AutoLinkResult> {
  try {
    if (!(await readAutoLinkEnabled(db, academyId))) return { linked: [], reason: "off" };
    const parentSnap = await parentDocRef(db, academyId, parentUid).get();
    if (!parentSnap.exists || !isAutoLinkAccountStatus(parentSnap.get("status"))) {
      return { linked: [], reason: "status" };
    }
    if (!isAccountPhoneVerified(parentSnap.data() ?? {})) return { linked: [], reason: "not_verified" };
    const phone = parentSnap.get("phone") as string;
    const key = parentSnap.get("phoneVerifiedKey") as string;

    const [indexSnap, sameKey] = await Promise.all([
      parentPhoneIndexRef(db, academyId, phone).get(),
      db.collection(`academies/${academyId}/parents`).where("phoneVerifiedKey", "==", key).get(),
    ]);
    const reason = autoLinkCandidateReason({
      parentUid,
      indexHolderUid: indexSnap.exists ? (indexSnap.get("parentUid") as string) : null,
      otherVerifiedStatuses: sameKey.docs.filter((d) => d.id !== parentUid).map((d) => d.get("status")),
    });
    if (reason !== "ok") return { linked: [], reason };

    const studentIds = opts.studentIds
      ? [...opts.studentIds]
      : (
        await db
          .collection(`academies/${academyId}/students`)
          .where("guardianPhones", "array-contains", key)
          .limit(MAX_AUTO_LINK_STUDENTS)
          .get()
      ).docs.map((d) => d.id);

    const displayName = typeof parentSnap.get("displayName") === "string" ? parentSnap.get("displayName") : "";
    const target = { uid: parentUid, phone, displayName };
    const linkedIds: string[] = [];
    for (const studentId of studentIds) {
      try {
        if ((await linkParentToStudentTx(db, academyId, target, studentId, { auto: true })) === "linked") {
          linkedIds.push(studentId);
        }
      } catch (e) {
        if (!(e instanceof HttpsError)) throw e;
        // 그 사이 계정·원생이 바뀜 — 이 원생은 건너뜀
      }
    }
    if (linkedIds.length === 0) return { linked: [], reason: "none" };

    // 상태(승인 대기 → 사용 중)·연결 목록을 바로 맞춘다(학생 트리거도 같은 일을 하지만 가입 응답·로그인 전에 끝나게)
    await refreshParentLinkSummary(db, academyId, parentUid);
    const studentSnaps = await db.getAll(...linkedIds.map((id) => db.doc(`academies/${academyId}/students/${id}`)));
    const linked = studentSnaps.map((s) => ({ id: s.id, name: typeof s.get("name") === "string" ? s.get("name") : "" }));
    for (const s of linked) {
      await writeInfoBell(db, academyId, autoLinkBellId(parentUid, s.id), {
        kind: "parent_auto_linked",
        entityType: "parent",
        entityId: parentUid,
        displayName: displayName || "이름 미입력",
        studentId: s.id,
        studentName: s.name,
      });
    }
    return { linked, reason: "linked" };
  } catch (e) {
    if (opts.throwOnError) throw e;
    logger.error("autoLinkVerifiedParent 실패(연결 없이 계속)", { academyId, parentUid, e });
    return { linked: [], reason: "none" };
  }
}

/**
 * 학생 트리거(★3) — 원생 문서에 새로 생긴 보호자 번호마다, 그 번호로 확인을 마친 학부모가 정확히 1명이면 이 원생에 자동 연결.
 * 연결 쓰기는 `linkedParentUid`만 바꾸고 `guardianPhones`는 그대로라, 다시 깬 트리거는 "새 번호 없음"으로 멈춘다.
 */
export async function autoLinkNewGuardianPhones(
  db: admin.firestore.Firestore,
  academyId: string,
  studentId: string,
  newKeys: readonly string[],
): Promise<number> {
  if (newKeys.length === 0) return 0;
  if (!(await readAutoLinkEnabled(db, academyId))) return 0;
  let count = 0;
  for (const key of newKeys) {
    const snap = await db.collection(`academies/${academyId}/parents`).where("phoneVerifiedKey", "==", key).get();
    const candidates = snap.docs.filter((d) => isAutoLinkAccountStatus(d.get("status")));
    if (candidates.length !== 1) continue;
    const r = await autoLinkVerifiedParent(db, academyId, candidates[0]!.id, {
      studentIds: [studentId],
      throwOnError: true,
    });
    count += r.linked.length;
  }
  return count;
}

/** 새로 생긴 보호자 번호(숫자 키) — 트리거 전후 `guardianPhones` 비교 */
export function newGuardianPhoneKeys(before: unknown, after: unknown): string[] {
  const list = (raw: unknown) => (Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  const prev = new Set(list(before));
  return [...new Set(list(after))].filter((k) => !prev.has(k)).sort();
}
