import * as admin from "firebase-admin";
import { FieldValue, type DocumentData, type Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { readUidList } from "./parent-recipients";

/**
 * 반(`academies/{id}/classes/{classId}`)과 학생의 반 파생 필드.
 * - 학생 `classIds`는 반 배정 함수만, `teacherUids`는 `classIds`의 반(종강 제외) 담당 선생님 합집합을 서버가 계산.
 * - 학생 쓰기는 항상 학생 1명 단위 트랜잭션: 학생 문서와 그 학생의 반 문서들을 같은 트랜잭션에서 읽고
 *   `classIds`·`teacherUids`를 함께 쓴다(batch 일괄 덮어쓰기 금지 — 동시 배정 결과를 예전 값으로 덮지 않게).
 * - 반 변경 이력은 `classHistory`에 저장만(규칙상 아무도 못 읽음).
 */

export const CLASS_STATUSES = ["active", "preparing", "ended"] as const;
export type ClassStatus = (typeof CLASS_STATUSES)[number];

export const MAX_CLASSES_PER_STUDENT = 20;

export const CLASS_ENDED_ADD_MSG = "종강한 반에는 원생을 추가할 수 없습니다. 반을 다시 열어 주세요.";

export type ClassHistoryType =
  | "created"
  | "updated"
  | "ended"
  | "reopened"
  | "deleted"
  | "students_added"
  | "students_removed";

export function isClassStatus(raw: unknown): raw is ClassStatus {
  return typeof raw === "string" && (CLASS_STATUSES as readonly string[]).includes(raw);
}

export function classesCol(db: admin.firestore.Firestore, academyId: string) {
  return db.collection(`academies/${academyId}/classes`);
}

export function classHistoryCol(db: admin.firestore.Firestore, academyId: string) {
  return db.collection(`academies/${academyId}/classHistory`);
}

/** 반이 학생에게 주는 담당 선생님 — 없는(삭제된) 반·종강 반은 없음 */
export function classContributedTeacherUids(data: DocumentData | undefined | null): string[] {
  if (!data || data.status === "ended") return [];
  return readUidList(data.teacherUids).sort();
}

/** `classIds`의 반 중 종강이 아닌 반의 `teacherUids` 합집합(정렬) */
export function computeTeacherUids(
  classIds: readonly string[],
  classesById: ReadonlyMap<string, DocumentData | undefined>,
): string[] {
  const out = new Set<string>();
  for (const id of classIds) {
    for (const uid of classContributedTeacherUids(classesById.get(id))) out.add(uid);
  }
  return [...out].sort();
}

export function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** 이력 한 건(트랜잭션 또는 batch 안에서 함께 쓴다) */
export function classHistoryEntry(params: {
  classId: string;
  className: string;
  type: ClassHistoryType;
  actorUid: string | null;
  changes?: Record<string, { before: unknown; after: unknown }>;
  studentIds?: string[];
}): Record<string, unknown> {
  return {
    classId: params.classId,
    className: params.className,
    type: params.type,
    ...(params.changes ? { changes: params.changes } : {}),
    ...(params.studentIds ? { studentIds: params.studentIds } : {}),
    actorUid: params.actorUid,
    at: FieldValue.serverTimestamp(),
  };
}

export type StudentClassChange = { add?: string; remove?: string };
export type StudentClassResult = "changed" | "unchanged" | "missing";

/**
 * 학생 1명의 `classIds`(add/remove 반영)와 `teacherUids`를 다시 계산(트랜잭션) — 달라졌을 때만 쓴다.
 * 학생 문서가 없으면 "missing". 추가하는 반이 없거나 종강이면, 반이 20개를 넘으면 HttpsError.
 * 여러 번 실행해도 결과가 같다(반 트리거 재시도에 안전).
 */
export async function recomputeStudentClassesTx(
  db: admin.firestore.Firestore,
  academyId: string,
  studentId: string,
  change: StudentClassChange = {},
): Promise<StudentClassResult> {
  const ref = db.doc(`academies/${academyId}/students/${studentId}`);
  const col = classesCol(db, academyId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return "missing";
    const current = readUidList(snap.get("classIds"));
    let next = current.filter((id) => id !== change.remove);
    const adding = change.add !== undefined && !next.includes(change.add);
    if (adding) {
      if (next.length >= MAX_CLASSES_PER_STUDENT) {
        throw new HttpsError(
          "failed-precondition",
          `한 원생은 반을 최대 ${MAX_CLASSES_PER_STUDENT}개까지 들을 수 있습니다.`,
        );
      }
      next = [...next, change.add!];
    }
    const classSnaps = next.length > 0 ? await tx.getAll(...next.map((id) => col.doc(id))) : [];
    const byId = new Map(classSnaps.map((s) => [s.id, s.exists ? s.data() : undefined]));
    if (adding) {
      const added = byId.get(change.add!);
      if (!added) throw new HttpsError("not-found", "반을 찾을 수 없습니다.");
      if (added.status === "ended") throw new HttpsError("failed-precondition", CLASS_ENDED_ADD_MSG);
    }
    const teacherUids = computeTeacherUids(next, byId);
    const prevTeachers = readUidList(snap.get("teacherUids")).sort();
    if (sameStringList(current, next) && sameStringList(prevTeachers, teacherUids)) return "unchanged";
    tx.update(ref, { classIds: next, teacherUids, updatedAt: FieldValue.serverTimestamp() });
    return "changed";
  });
}

/** 반 학생 id 목록(`classIds array-contains`) */
export async function listClassStudentIds(
  db: admin.firestore.Firestore,
  academyId: string,
  classId: string,
): Promise<string[]> {
  const snap = await db
    .collection(`academies/${academyId}/students`)
    .where("classIds", "array-contains", classId)
    .select()
    .get();
  return snap.docs.map((d) => d.id);
}

/**
 * 직원 계정 삭제 — 모든 반 `teacherUids`에서 그 uid를 뺀다(반마다 트랜잭션 + 이력).
 * 학생 `teacherUids`는 반 트리거(`onAcademyClassWritten`)가 맞춘다.
 * staff 문서 분리·삭제가 끝난 뒤에 부를 것(그 사이 저장된 반에 지운 uid가 남지 않게 — `saveClass`는 새 uid만 검사).
 */
export async function stripTeacherFromClasses(
  db: admin.firestore.Firestore,
  academyId: string,
  teacherUid: string,
  actorUid: string | null,
): Promise<number> {
  const col = classesCol(db, academyId);
  const snap = await col.where("teacherUids", "array-contains", teacherUid).select().get();
  let changed = 0;
  for (const d of snap.docs) {
    const did = await db.runTransaction(async (tx: Transaction) => {
      const cur = await tx.get(d.ref);
      if (!cur.exists) return false;
      const before = readUidList(cur.get("teacherUids"));
      if (!before.includes(teacherUid)) return false;
      const after = before.filter((uid) => uid !== teacherUid);
      tx.update(d.ref, { teacherUids: after, updatedAt: FieldValue.serverTimestamp() });
      tx.set(
        classHistoryCol(db, academyId).doc(),
        classHistoryEntry({
          classId: d.id,
          className: typeof cur.get("name") === "string" ? cur.get("name") : "",
          type: "updated",
          actorUid,
          changes: { teacherUids: { before, after } },
        }),
      );
      return true;
    });
    if (did) changed += 1;
  }
  return changed;
}
