import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { actorHasPermission, type AcademyActor } from "./academy-access";
import { normalizePermissionList } from "./permissions";

/**
 * 3-A 출결 정정 이력 — `academies/{id}/attendanceCorrections/{auto}`(서버 전용 쓰기, 출결 권한 읽기).
 * 지난 날짜 정정·사유와 코멘트 바꾸기·기존 기록 삭제·기간 결석 덮어쓰기(지난 날짜)를 누가·언제·전→후로 남긴다(★5).
 * 오늘 버튼·취소는 알림 기록(`attendanceNotifications`)이 있어 남기지 않는다.
 */

export type CorrectionLayer = "arrival" | "class";
export type CorrectionAction = "create" | "update" | "delete" | "detail";
export const CORRECTION_VIA = ["attendance_screen", "attendance_batch", "student_detail"] as const;
export type CorrectionVia = (typeof CORRECTION_VIA)[number];

/** 이력에 남기는 등원 기록 상태 */
export type ArrivalState = {
  status: "present" | "absent";
  reason: string | null;
  note: string | null;
  arrivedAt: Timestamp | null;
};

/** 이력에 남기는 반 출결 상태 */
export type ClassState = {
  status: "present" | "absent";
  reason: string | null;
  comment: string | null;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function arrivalStateOf(data: FirebaseFirestore.DocumentData | undefined): ArrivalState | null {
  if (!data) return null;
  return {
    status: data.status === "absent" ? "absent" : "present",
    reason: str(data.reason),
    note: str(data.note),
    arrivedAt: data.arrivedAt instanceof Timestamp ? data.arrivedAt : null,
  };
}

export function classStateOf(data: FirebaseFirestore.DocumentData | undefined): ClassState | null {
  if (!data) return null;
  return {
    status: data.status === "absent" ? "absent" : "present",
    reason: str(data.reason),
    comment: str(data.comment),
  };
}

/** 이력의 처리한 사람 — 원장은 "원장", 직원은 직원 문서 이름 */
export type CorrectionActor = { byUid: string; byRole: "owner" | "staff"; byName: string };

export function staffDocRef(db: admin.firestore.Firestore, academyId: string, uid: string) {
  return db.doc(`academies/${academyId}/staff/${uid}`);
}

/**
 * 트랜잭션 안 권한 재확인(정정·사유 바꾸기 = 원장·`lessons.attendance`).
 * 원장 여부는 트랜잭션 밖 `resolveAcademyActor`가 학원 문서로 확인했고, 직원은 이 트랜잭션에서 읽은 직원 문서로 다시 본다.
 */
export function correctionActorFromTx(
  actor: AcademyActor,
  staffSnap: FirebaseFirestore.DocumentSnapshot | null,
  deniedMessage: string,
): CorrectionActor {
  if (actor.kind === "owner") return { byUid: actor.uid, byRole: "owner", byName: "원장" };
  const ok =
    staffSnap?.exists === true &&
    staffSnap.get("status") === "active" &&
    normalizePermissionList(staffSnap.get("permissions")).includes("lessons.attendance");
  if (!ok) throw new HttpsError("permission-denied", deniedMessage);
  const name = staffSnap!.get("displayName");
  return { byUid: actor.uid, byRole: "staff", byName: typeof name === "string" && name ? name : "직원" };
}

/** 트랜잭션 밖 1차 확인 — 원장 또는 출결 권한 직원 */
export function assertCorrectionActor(actor: AcademyActor | null, deniedMessage: string): AcademyActor {
  if (!actor || (actor.kind === "staff" && !actorHasPermission(actor, "lessons.attendance"))) {
    throw new HttpsError("permission-denied", deniedMessage);
  }
  return actor;
}

/** 트랜잭션 밖에서 쓰는 이력(기존 함수 — 기록 삭제·기간 결석)의 처리한 사람 */
export async function correctionActorOutsideTx(
  db: admin.firestore.Firestore,
  academyId: string,
  actor: AcademyActor,
): Promise<CorrectionActor> {
  if (actor.kind === "owner") return { byUid: actor.uid, byRole: "owner", byName: "원장" };
  const snap = await staffDocRef(db, academyId, actor.uid).get();
  const name = snap.get("displayName");
  return { byUid: actor.uid, byRole: "staff", byName: typeof name === "string" && name ? name : "직원" };
}

export function correctionsCol(db: admin.firestore.Firestore, academyId: string) {
  return db.collection(`academies/${academyId}/attendanceCorrections`);
}

export type CorrectionEntry = {
  academyId: string;
  date: string;
  studentId: string;
  studentName: string;
  classId: string | null;
  className: string | null;
  layer: CorrectionLayer;
  action: CorrectionAction;
  before: ArrivalState | ClassState | null;
  after: ArrivalState | ClassState | null;
  via: CorrectionVia;
  by: CorrectionActor;
};

function entryData(e: CorrectionEntry) {
  return {
    academyId: e.academyId,
    date: e.date,
    studentId: e.studentId,
    studentName: e.studentName,
    classId: e.classId,
    className: e.className,
    layer: e.layer,
    action: e.action,
    before: e.before,
    after: e.after,
    via: e.via,
    byUid: e.by.byUid,
    byRole: e.by.byRole,
    byName: e.by.byName,
    at: FieldValue.serverTimestamp(),
  };
}

/** 트랜잭션 안 이력 생성(정정 기록과 같은 커밋) */
export function writeCorrectionTx(
  tx: FirebaseFirestore.Transaction,
  db: admin.firestore.Firestore,
  e: CorrectionEntry,
): void {
  tx.create(correctionsCol(db, e.academyId).doc(), entryData(e));
}

export function studentNameOf(data: FirebaseFirestore.DocumentData | undefined): string {
  return typeof data?.name === "string" && data.name ? data.name : "학생";
}

/** "이력 after"용 — 쓰기 직후 상태를 쓰는 값으로 다시 만든다(serverTimestamp 필드는 넣지 않음) */
export function mergedArrivalState(
  prev: ArrivalState | null,
  next: { status: "present" | "absent"; reason: string | null; arrivedAt: Timestamp | null | "keep"; note?: string | null },
): ArrivalState {
  return {
    status: next.status,
    reason: next.reason,
    note: next.note !== undefined ? next.note : prev?.note ?? null,
    arrivedAt: next.arrivedAt === "keep" ? prev?.arrivedAt ?? null : next.arrivedAt,
  };
}
