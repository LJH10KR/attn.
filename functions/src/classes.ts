import * as admin from "firebase-admin";
import { FieldValue, type DocumentData, type Transaction } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { academyOptionsRef, readOptionItems } from "./academy-options";
import { assertPermission } from "./lib/academy-access";
import {
  classContributedTeacherUids,
  classesCol,
  classHistoryCol,
  classHistoryEntry,
  CLASS_ENDED_ADD_MSG,
  isClassStatus,
  listClassStudentIds,
  recomputeStudentClassesTx,
  sameStringList,
  type ClassHistoryType,
  type ClassStatus,
} from "./lib/class-teachers";
import { parseSchedule, readSchedule, type ScheduleSlot } from "./lib/class-schedule";
import { readUidList } from "./lib/parent-recipients";
import { isRetriableError, MAX_TRIGGER_RETRY_AGE_MS, triggerEventAgeMs } from "./lib/trigger-retry";

/**
 * 운영 › 반 관리 — `academies/{academyId}/classes/{classId}`.
 * 반 문서·학생 `classIds`는 이 함수들만 쓰고(규칙상 클라이언트 쓰기 불가), 학생 `teacherUids`는
 * 원생 배정(`setClassStudents`)·반 삭제는 같은 호출에서, 반의 선생님·상태 변경은 트리거가 학생마다 트랜잭션으로 맞춘다.
 * 변경 이력은 `classHistory`에 저장만 한다.
 */

const MAX_NAME_LENGTH = 40;
const MAX_CLASS_TEACHERS = 10;
const MAX_CAPACITY = 500;
const MAX_ASSIGN_PER_CALL = 100;
const MAX_CLASSES_PER_ACADEMY = 300;

function requireId(raw: unknown, message = "요청이 올바르지 않습니다."): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.includes("/")) {
    throw new HttpsError("invalid-argument", message);
  }
  return s;
}

function parseIdList(raw: unknown, message: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpsError("invalid-argument", message);
  return [...new Set(raw.map((x) => requireId(x, message)))];
}

function parseName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new HttpsError("invalid-argument", `반 이름을 1~${MAX_NAME_LENGTH}자로 입력해 주세요.`);
  }
  return name;
}

function parseTeacherUids(raw: unknown): string[] {
  const uids = parseIdList(raw, "선생님 정보가 올바르지 않습니다.");
  if (uids.length > MAX_CLASS_TEACHERS) {
    throw new HttpsError("invalid-argument", `반 선생님은 최대 ${MAX_CLASS_TEACHERS}명까지 지정할 수 있습니다.`);
  }
  return uids.sort();
}

function parseCapacity(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_CAPACITY) {
    throw new HttpsError("invalid-argument", `정원은 1~${MAX_CAPACITY}명으로 입력하거나 비워 두세요.`);
  }
  return raw;
}

function parseRoomId(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  return requireId(raw, "강의실 정보가 올바르지 않습니다.");
}

function parseClassStatus(raw: unknown): ClassStatus {
  if (raw === undefined || raw === null) return "active";
  if (isClassStatus(raw)) return raw;
  throw new HttpsError("invalid-argument", "반 상태가 올바르지 않습니다.");
}

/** 새로 고른 강의실만 검사 — 선택지에 없으면(삭제됨) 거부 */
async function assertRoomTx(
  tx: Transaction,
  db: admin.firestore.Firestore,
  academyId: string,
  roomId: string,
): Promise<void> {
  const options = await tx.get(academyOptionsRef(db, academyId));
  if (!readOptionItems(options.get("rooms")).some((o) => o.id === roomId)) {
    throw new HttpsError("failed-precondition", "선택한 강의실이 삭제되었습니다. 다시 선택해 주세요.");
  }
}

/**
 * 새로 추가된 반 선생님만 검사(D6) — 원장 uid 또는 계정이 있는 직원(staff 문서 ID = Auth uid).
 * 계정 없는 직원은 문서 ID가 계정 연결·분리 때 바뀌므로 고를 수 없다.
 */
async function assertNewClassTeachersTx(
  tx: Transaction,
  db: admin.firestore.Firestore,
  academyId: string,
  uids: readonly string[],
): Promise<void> {
  if (uids.length === 0) return;
  const academy = await tx.get(db.doc(`academies/${academyId}`));
  const ownerUid = academy.get("ownerUid");
  const staffUids = uids.filter((uid) => uid !== ownerUid);
  if (staffUids.length === 0) return;
  const snaps = await tx.getAll(...staffUids.map((uid) => db.doc(`academies/${academyId}/staff/${uid}`)));
  for (const s of snaps) {
    if (!s.exists || s.get("authUid") !== s.id || s.get("status") === "no_account") {
      throw new HttpsError("failed-precondition", "반 선생님은 원장 또는 계정이 있는 직원만 지정할 수 있습니다.");
    }
  }
}

type ClassFields = {
  name: string;
  status: ClassStatus;
  schedule: ScheduleSlot[];
  teacherUids: string[];
  roomId: string | null;
  capacity: number | null;
};

function readClassFields(d: DocumentData): ClassFields {
  return {
    name: typeof d.name === "string" ? d.name : "",
    status: isClassStatus(d.status) ? d.status : "active",
    schedule: readSchedule(d.schedule),
    teacherUids: readUidList(d.teacherUids).sort(),
    roomId: typeof d.roomId === "string" && d.roomId ? d.roomId : null,
    capacity: typeof d.capacity === "number" ? d.capacity : null,
  };
}

/**
 * 수정 요청에서 보낸 필드만 parse — 빠진 필드는 기존 값 유지.
 * 이름·상태·수업 시간·선생님은 null도 "유지"로 보고, 강의실·정원만 null(또는 "")이 "비움"이다.
 * (예전에는 빠진 필드가 기본값으로 덮여 status 생략 → 종강 반 재개, teacherUids 생략 → 선생님 전부 제거가 됐음)
 */
function parseClassPatch(data: Record<string, unknown>): Partial<ClassFields> {
  const patch: Partial<ClassFields> = {};
  const sent = (raw: unknown) => raw !== undefined && raw !== null;
  if (sent(data.name)) patch.name = parseName(data.name);
  if (sent(data.status)) patch.status = parseClassStatus(data.status);
  if (sent(data.schedule)) patch.schedule = parseSchedule(data.schedule);
  if (sent(data.teacherUids)) patch.teacherUids = parseTeacherUids(data.teacherUids);
  if (data.roomId !== undefined) patch.roomId = parseRoomId(data.roomId);
  if (data.capacity !== undefined) patch.capacity = parseCapacity(data.capacity);
  return patch;
}

/** 반 추가(classId 없음)·수정 — 시간·선생님·강의실·정원·상태, 이력. 수정은 보낸 필드만 바꾼다 */
export const saveClass = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const callerUid = request.auth.uid;
  const data = (request.data ?? {}) as Record<string, unknown>;
  const academyId = requireId(data.academyId, "학원 ID가 필요합니다.");
  const classIdRaw = data.classId;
  const classId =
    classIdRaw === undefined || classIdRaw === null || classIdRaw === ""
      ? null
      : requireId(classIdRaw, "반 정보가 올바르지 않습니다.");
  // 생성은 빠진 필드에 기본값(운영중·시간 없음·선생님 없음), 수정은 보낸 필드만
  const input: ClassFields | null = classId ? null : {
    name: parseName(data.name),
    status: parseClassStatus(data.status),
    schedule: parseSchedule(data.schedule),
    teacherUids: parseTeacherUids(data.teacherUids),
    roomId: parseRoomId(data.roomId),
    capacity: parseCapacity(data.capacity),
  };
  const patch = classId ? parseClassPatch(data) : null;

  const db = admin.firestore();
  await assertPermission(db, academyId, callerUid, request.auth.token, "operations.classes");
  const col = classesCol(db, academyId);

  if (input) {
    if ((await col.count().get()).data().count >= MAX_CLASSES_PER_ACADEMY) {
      throw new HttpsError("failed-precondition", `반은 최대 ${MAX_CLASSES_PER_ACADEMY}개까지 만들 수 있습니다.`);
    }
    const ref = col.doc();
    await db.runTransaction(async (tx) => {
      const last = await tx.get(col.orderBy("sortOrder", "desc").limit(1));
      if (input.roomId) await assertRoomTx(tx, db, academyId, input.roomId);
      await assertNewClassTeachersTx(tx, db, academyId, input.teacherUids);
      const lastOrder = last.empty ? -1 : Number(last.docs[0]!.get("sortOrder")) || 0;
      tx.create(ref, {
        ...input,
        sortOrder: lastOrder + 1,
        endedAt: input.status === "ended" ? FieldValue.serverTimestamp() : null,
        createdByUid: callerUid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(
        classHistoryCol(db, academyId).doc(),
        classHistoryEntry({ classId: ref.id, className: input.name, type: "created", actorUid: callerUid }),
      );
    });
    return { ok: true as const, classId: ref.id, changed: true };
  }

  if (!classId || !patch) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }
  const ref = col.doc(classId);
  const changed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError("not-found", "반을 찾을 수 없습니다.");
    }
    // 합치기·바뀐 필드·검사는 모두 이 트랜잭션에서 읽은 반 문서 기준
    const stored = readClassFields(snap.data() ?? {});
    const merged: ClassFields = { ...stored, ...patch };
    // 바뀌지 않은 값은 다시 검사하지 않는다(삭제된 강의실·퇴사 직원이 그대로 남아 있어도 다른 필드 수정 가능)
    if (merged.roomId && merged.roomId !== stored.roomId) {
      await assertRoomTx(tx, db, academyId, merged.roomId);
    }
    await assertNewClassTeachersTx(
      tx,
      db,
      academyId,
      merged.teacherUids.filter((uid) => !stored.teacherUids.includes(uid)),
    );

    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of Object.keys(patch) as (keyof ClassFields)[]) {
      if (JSON.stringify(stored[key]) !== JSON.stringify(merged[key])) {
        changes[key] = { before: stored[key], after: merged[key] };
      }
    }
    const changedKeys = Object.keys(changes) as (keyof ClassFields)[];
    if (changedKeys.length === 0) return false;

    const ending = stored.status !== "ended" && merged.status === "ended";
    const reopening = stored.status === "ended" && merged.status !== "ended";
    const type: ClassHistoryType = ending ? "ended" : reopening ? "reopened" : "updated";
    tx.update(ref, {
      ...Object.fromEntries(changedKeys.map((k) => [k, merged[k]])),
      ...(ending ? { endedAt: FieldValue.serverTimestamp() } : {}),
      ...(reopening ? { endedAt: null } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(
      classHistoryCol(db, academyId).doc(),
      classHistoryEntry({ classId, className: merged.name, type, actorUid: callerUid, changes }),
    );
    return true;
  });
  return { ok: true as const, classId, changed };
});

/** 반 삭제 — 학생마다 트랜잭션으로 `classIds`에서 빼고 `teacherUids` 재계산, 그 뒤 반 문서 삭제·이력 */
export const deleteClass = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const callerUid = request.auth.uid;
  const academyId = requireId(request.data?.academyId, "학원 ID가 필요합니다.");
  const classId = requireId(request.data?.classId, "반 정보가 올바르지 않습니다.");

  const db = admin.firestore();
  await assertPermission(db, academyId, callerUid, request.auth.token, "operations.classes");

  const ref = classesCol(db, academyId).doc(classId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "반을 찾을 수 없습니다.");
  }
  const studentIds = await listClassStudentIds(db, academyId, classId);
  const removed: string[] = [];
  for (const studentId of studentIds) {
    if ((await recomputeStudentClassesTx(db, academyId, studentId, { remove: classId })) === "changed") {
      removed.push(studentId);
    }
  }
  // 그 사이 배정된 학생이 있어도 반 트리거가 삭제 이벤트에서 `classIds`를 정리한다
  const batch = db.batch();
  batch.delete(ref);
  batch.set(
    classHistoryCol(db, academyId).doc(),
    classHistoryEntry({
      classId,
      className: typeof snap.get("name") === "string" ? snap.get("name") : "",
      type: "deleted",
      actorUid: callerUid,
      studentIds: removed,
    }),
  );
  await batch.commit();
  return { ok: true as const, removedStudentCount: removed.length };
});

/** 반 목록 순서 — 학원의 반 전체 id를 원하는 순서로 */
export const reorderClasses = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireId(request.data?.academyId, "학원 ID가 필요합니다.");
  const orderedIds = parseIdList(request.data?.orderedIds, "반 순서가 올바르지 않습니다.");
  if (!Array.isArray(request.data?.orderedIds) || orderedIds.length !== request.data.orderedIds.length) {
    throw new HttpsError("invalid-argument", "반 순서가 올바르지 않습니다.");
  }

  const db = admin.firestore();
  await assertPermission(db, academyId, request.auth.uid, request.auth.token, "operations.classes");

  const all = await classesCol(db, academyId).select("sortOrder").get();
  const existing = new Set(all.docs.map((d) => d.id));
  if (existing.size !== orderedIds.length || orderedIds.some((id) => !existing.has(id))) {
    throw new HttpsError("failed-precondition", "반 목록이 바뀌었습니다. 새로고침한 뒤 다시 시도해 주세요.");
  }
  const currentOrder = new Map(all.docs.map((d) => [d.id, d.get("sortOrder")]));
  const batch = db.batch();
  let changed = 0;
  orderedIds.forEach((id, i) => {
    if (currentOrder.get(id) === i) return;
    batch.update(classesCol(db, academyId).doc(id), { sortOrder: i, updatedAt: FieldValue.serverTimestamp() });
    changed += 1;
  });
  if (changed > 0) await batch.commit();
  return { ok: true as const, changed };
});

type AssignFailure = { studentId: string; message: string };

/**
 * 원생 배정 `{classId, add[], remove[]}` — 학생마다 트랜잭션(학생 문서와 그 학생의 반 문서들을 안에서 읽고
 * `classIds`·`teacherUids`를 함께 씀). 종강한 반에는 추가 불가(해제는 가능). 정원 초과는 막지 않고 `overCapacity`로 알림.
 */
export const setClassStudents = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const callerUid = request.auth.uid;
  const academyId = requireId(request.data?.academyId, "학원 ID가 필요합니다.");
  const classId = requireId(request.data?.classId, "반 정보가 올바르지 않습니다.");
  const add = parseIdList(request.data?.add, "원생 정보가 올바르지 않습니다.");
  const remove = parseIdList(request.data?.remove, "원생 정보가 올바르지 않습니다.");
  if (add.length + remove.length === 0) {
    throw new HttpsError("invalid-argument", "추가하거나 해제할 원생을 선택해 주세요.");
  }
  if (add.length + remove.length > MAX_ASSIGN_PER_CALL) {
    throw new HttpsError("invalid-argument", `한 번에 ${MAX_ASSIGN_PER_CALL}명까지 바꿀 수 있습니다.`);
  }
  if (add.some((id) => remove.includes(id))) {
    throw new HttpsError("invalid-argument", "같은 원생을 추가와 해제에 함께 넣을 수 없습니다.");
  }

  const db = admin.firestore();
  await assertPermission(db, academyId, callerUid, request.auth.token, "operations.classes");

  const ref = classesCol(db, academyId).doc(classId);
  const classSnap = await ref.get();
  if (!classSnap.exists) {
    throw new HttpsError("not-found", "반을 찾을 수 없습니다.");
  }
  if (add.length > 0 && classSnap.get("status") === "ended") {
    throw new HttpsError("failed-precondition", CLASS_ENDED_ADD_MSG);
  }

  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  const failures: AssignFailure[] = [];
  const run = async (studentId: string, change: { add?: string; remove?: string }, done: string[]) => {
    try {
      const r = await recomputeStudentClassesTx(db, academyId, studentId, change);
      if (r === "missing") failures.push({ studentId, message: "원생 정보를 찾을 수 없습니다." });
      else (r === "changed" ? done : unchanged).push(studentId);
    } catch (e) {
      if (!(e instanceof HttpsError)) throw e;
      failures.push({ studentId, message: e.message });
    }
  };
  for (const studentId of add) await run(studentId, { add: classId }, added);
  for (const studentId of remove) await run(studentId, { remove: classId }, removed);

  const className = typeof classSnap.get("name") === "string" ? classSnap.get("name") : "";
  if (added.length + removed.length > 0) {
    const batch = db.batch();
    const history = classHistoryCol(db, academyId);
    if (added.length > 0) {
      batch.set(history.doc(), classHistoryEntry({
        classId, className, type: "students_added", actorUid: callerUid, studentIds: added,
      }));
    }
    if (removed.length > 0) {
      batch.set(history.doc(), classHistoryEntry({
        classId, className, type: "students_removed", actorUid: callerUid, studentIds: removed,
      }));
    }
    await batch.commit();
  }

  const [countSnap, latest] = await Promise.all([
    db.collection(`academies/${academyId}/students`).where("classIds", "array-contains", classId).count().get(),
    ref.get(),
  ]);
  const studentCount = countSnap.data().count;
  const capacity = typeof latest.get("capacity") === "number" ? (latest.get("capacity") as number) : null;
  return {
    ok: true as const,
    added,
    removed,
    unchanged,
    failures,
    studentCount,
    capacity,
    overCapacity: capacity !== null && studentCount > capacity,
  };
});

/**
 * 반의 담당 선생님·종강 여부가 바뀌거나 반이 삭제되면 그 반 학생들의 `teacherUids`를 맞춘다.
 * 학생마다 트랜잭션으로 학생 문서와 그 학생의 반 문서들을 다시 읽어 계산(같은 시점의 원생 배정 결과를 덮지 않게).
 * 삭제된 반은 학생 `classIds`에서도 뺀다(`deleteClass`와 동시에 들어온 배정 정리).
 * "현재 값에 맞추기"라 재시도로 여러 번 와도 결과가 같다.
 */
export const onAcademyClassWritten = onDocumentWritten(
  { document: "academies/{academyId}/classes/{classId}", region: "asia-northeast3", retry: true },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : undefined;
    const after = event.data?.after?.exists ? event.data.after.data() : undefined;
    const deleted = before !== undefined && after === undefined;
    if (!deleted && sameStringList(classContributedTeacherUids(before), classContributedTeacherUids(after))) {
      return;
    }

    const { academyId, classId } = event.params;
    const eventAgeMs = triggerEventAgeMs(event.time);
    if (eventAgeMs > MAX_TRIGGER_RETRY_AGE_MS) {
      logger.error("onAcademyClassWritten: 오래된 이벤트 — 처리하지 않음", { academyId, classId, eventAgeMs });
      return;
    }

    const db = admin.firestore();
    try {
      const studentIds = await listClassStudentIds(db, academyId, classId);
      let changed = 0;
      for (const studentId of studentIds) {
        const r = await recomputeStudentClassesTx(db, academyId, studentId, deleted ? { remove: classId } : {});
        if (r === "changed") changed += 1;
      }
      logger.info("onAcademyClassWritten: 학생 담당 선생님 맞춤", {
        academyId, classId, deleted, students: studentIds.length, changed,
      });
    } catch (e) {
      if (isRetriableError(e)) {
        logger.warn("onAcademyClassWritten: 일시 오류 — 재시도", { academyId, classId, e });
        throw e;
      }
      logger.error("onAcademyClassWritten: 처리 실패(재시도 안 함)", { academyId, classId, e });
    }
  },
);
