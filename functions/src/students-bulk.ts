import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { academyOptionsRef, readOptionItems } from "./academy-options";
import { actorHasPermission, assertPermission } from "./lib/academy-access";
import { academySeqMetaPath, formatStudentAttnId } from "./lib/attn-id";
import { classesCol, classHistoryCol, classHistoryEntry, recomputeStudentClassesTx } from "./lib/class-teachers";
import {
  BULK_MSG,
  bulkDuplicateKey,
  MAX_BULK_STUDENTS,
  normalizeBulkPhone,
  validateBulkStudentInput,
  type BulkClassOption,
} from "./lib/student-bulk";
import { newStudentDocFields, parseStudentName, parseStudentSchool, resolveGrade } from "./lib/student-create";
import { parseGuardiansInput, type Guardian } from "./lib/student-guardians";
import { displayGrade, kstYear, type GradeCode } from "./lib/student-profile";

/**
 * 원생 여러 명 입력 표(2-M, ★1) — 새 원생만 추가(★2). 한 번 최대 200줄, 줄마다 성공/실패.
 * 검증·파생 필드는 원생 1명 저장(`saveStudent`)과 같은 함수(`lib/student-create.ts`·`parseGuardiansInput`)를 쓰고,
 * 학생 번호는 한 트랜잭션에서 미리 잡는다(동시 저장과 경합 없음 — 쓰기가 실패한 줄은 번호가 비어도 무해).
 * 학생 문서가 생기면 학생 트리거가 새 보호자 번호로 자동 연결(2-L ★3)을 돈다 — `saveStudent` 생성과 같은 경로.
 * 반 칸은 반 관리와 같은 함수(`recomputeStudentClassesTx`)로 배정하고 반마다 이력 1건(★4, `operations.classes` 필요).
 * 새 원생의 보호자 칸은 연결이 없으므로(`linkedParentUid: null`) 학원 번호 변경 안내(`phoneNotice`)는 생기지 않는다.
 */

const WRITE_CONCURRENCY = 20;
const MAX_ROW_KEY_LENGTH = 64;
const WRITE_FAILED_MSG = "저장하지 못했어요. 다시 시도해 주세요.";

type RowResult =
  | { rowKey: string; ok: true; studentId: string; attnId: string; classAssigned: boolean; classError?: string }
  | { rowKey: string; ok: false; code: "invalid" | "duplicate" | "class_permission" | "write_failed"; message: string };

type Accepted = {
  index: number;
  rowKey: string;
  name: string;
  school: string;
  grade: { grade: GradeCode; gradeYear: number };
  guardians: Guardian[];
  classId: string | null;
};

function requireString(raw: unknown, message: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.includes("/")) {
    throw new HttpsError("invalid-argument", message);
  }
  return s;
}

function readRowKey(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.length > MAX_ROW_KEY_LENGTH) {
    throw new HttpsError("invalid-argument", "표 줄 정보가 올바르지 않습니다.");
  }
  return s;
}

/** 보호자 칸 — 번호는 표 검사와 같은 규칙으로 맞춤(+82 → 010), 형식이 틀린 번호는 그대로 두어 검사가 거부 */
function readGuardiansRaw(raw: unknown): { relationId: string | null; phone: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((g) => {
    const o = (g ?? {}) as Record<string, unknown>;
    const phone = typeof o.phone === "string" ? o.phone : "";
    return {
      relationId: typeof o.relationId === "string" && o.relationId ? o.relationId : null,
      phone: normalizeBulkPhone(phone) ?? phone,
    };
  });
}

export const createStudentsBulk = onCall({ timeoutSeconds: 120 }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const callerUid = request.auth.uid;
  const academyId = requireString(request.data?.academyId, "학원 ID가 필요합니다.");
  const rawRows: unknown = request.data?.rows;
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw new HttpsError("invalid-argument", "저장할 원생이 없습니다.");
  }
  if (rawRows.length > MAX_BULK_STUDENTS) {
    throw new HttpsError("invalid-argument", `한 번에 ${MAX_BULK_STUDENTS}명까지 저장할 수 있어요.`);
  }
  const rows = rawRows.map((r) => (r ?? {}) as Record<string, unknown>);
  const rowKeys = rows.map((r) => readRowKey(r.rowKey));
  if (new Set(rowKeys).size !== rowKeys.length) {
    throw new HttpsError("invalid-argument", "표 줄 정보가 올바르지 않습니다.");
  }
  const startedAt = Date.now();

  const db = admin.firestore();
  const actor = await assertPermission(db, academyId, callerUid, request.auth.token, "operations.students");
  const canAssignClass = actorHasPermission(actor, "operations.classes");
  const studentsCol = db.collection(`academies/${academyId}/students`);

  const [optionsSnap, classesSnap, existingSnap] = await Promise.all([
    academyOptionsRef(db, academyId).get(),
    classesCol(db, academyId).select("name", "status").get(),
    studentsCol.select("name", "grade", "gradeYear").get(),
  ]);
  const relationIds = new Set(readOptionItems(optionsSnap.get("guardianRelations")).map((o) => o.id));
  const classes: BulkClassOption[] = classesSnap.docs.map((d) => ({
    id: d.id,
    name: typeof d.get("name") === "string" ? (d.get("name") as string) : "",
    status: typeof d.get("status") === "string" ? (d.get("status") as string) : "",
  }));
  const nowYear = kstYear();
  const existingKeys = new Set(
    existingSnap.docs.map((d) =>
      bulkDuplicateKey(
        typeof d.get("name") === "string" ? (d.get("name") as string) : "",
        displayGrade(d.get("grade"), d.get("gradeYear"), nowYear),
      ),
    ),
  );

  const results: RowResult[] = new Array(rows.length);
  const accepted: Accepted[] = [];
  const batchKeys = new Set<string>();

  rows.forEach((row, index) => {
    const rowKey = rowKeys[index]!;
    const classIdRaw = typeof row.classId === "string" && row.classId ? row.classId : null;
    const guardiansRaw = readGuardiansRaw(row.guardians);
    const errors = validateBulkStudentInput(
      {
        name: typeof row.name === "string" ? row.name : "",
        grade: typeof row.grade === "string" ? row.grade : "",
        school: typeof row.school === "string" ? row.school : "",
        guardians: guardiansRaw,
        classId: classIdRaw,
      },
      { relationIds, classes, canAssignClass },
    );
    if (errors.length > 0) {
      const permission = errors.some((e) => e.message === BULK_MSG.classNoPermission);
      results[index] = {
        rowKey,
        ok: false,
        code: permission ? "class_permission" : "invalid",
        message: errors[0]!.message,
      };
      return;
    }
    try {
      const name = parseStudentName(row.name);
      const school = parseStudentSchool(row.school);
      const grade = resolveGrade(row.grade, null, nowYear);
      // 원생 1명 저장과 같은 보호자 검증(번호 형식·중복·관계·대표) — 새 원생이라 기존 연결 없음
      const guardians = parseGuardiansInput(guardiansRaw, [], relationIds);
      const dupKey = bulkDuplicateKey(name, grade.grade);
      if (row.allowDuplicate !== true && (existingKeys.has(dupKey) || batchKeys.has(dupKey))) {
        results[index] = { rowKey, ok: false, code: "duplicate", message: BULK_MSG.duplicateServer };
        return;
      }
      batchKeys.add(dupKey);
      accepted.push({ index, rowKey, name, school, grade, guardians, classId: classIdRaw });
    } catch (e) {
      if (!(e instanceof HttpsError)) throw e;
      results[index] = { rowKey, ok: false, code: "invalid", message: e.message };
    }
  });

  // 학생 번호 n개를 한 번에 잡는다
  let firstSeq = 0;
  if (accepted.length > 0) {
    const seqRef = db.doc(academySeqMetaPath(academyId));
    firstSeq = await db.runTransaction(async (tx) => {
      const seqSnap = await tx.get(seqRef);
      const next = (seqSnap.get("nextStudentSeq") as number) || 1;
      tx.set(seqRef, { nextStudentSeq: next + accepted.length }, { merge: true });
      return next;
    });
  }

  const created: { a: Accepted; studentId: string }[] = [];
  for (let i = 0; i < accepted.length; i += WRITE_CONCURRENCY) {
    const chunk = accepted.slice(i, i + WRITE_CONCURRENCY);
    await Promise.all(
      chunk.map(async (a, j) => {
        const ref = studentsCol.doc();
        const attnId = formatStudentAttnId(academyId, firstSeq + i + j);
        try {
          await ref.create(
            newStudentDocFields({
              attnId,
              profile: { name: a.name, school: a.school || null, phone: null, firstAttendedOn: null },
              grade: a.grade,
              status: "enrolled",
              guardians: a.guardians,
              callerUid,
            }),
          );
          results[a.index] = { rowKey: a.rowKey, ok: true, studentId: ref.id, attnId, classAssigned: false };
          created.push({ a, studentId: ref.id });
        } catch (e) {
          logger.error("createStudentsBulk: 원생 쓰기 실패", { academyId, rowKey: a.rowKey, e });
          results[a.index] = { rowKey: a.rowKey, ok: false, code: "write_failed", message: WRITE_FAILED_MSG };
        }
      }),
    );
  }

  // 반 배정 — 반 관리와 같은 학생별 트랜잭션. 원생은 이미 저장됐으므로 실패해도 그 줄은 성공(반 오류만 알림)
  const addedByClass = new Map<string, string[]>();
  for (const { a, studentId } of created) {
    if (!a.classId) continue;
    const r = results[a.index];
    if (!r || !r.ok) continue;
    try {
      const outcome = await recomputeStudentClassesTx(db, academyId, studentId, { add: a.classId });
      if (outcome === "missing") {
        r.classError = "원생 정보를 찾을 수 없습니다.";
        continue;
      }
      r.classAssigned = true;
      if (outcome === "changed") addedByClass.set(a.classId, [...(addedByClass.get(a.classId) ?? []), studentId]);
    } catch (e) {
      if (!(e instanceof HttpsError)) {
        logger.error("createStudentsBulk: 반 배정 실패", { academyId, studentId, e });
        r.classError = "반 배정을 하지 못했어요.";
        continue;
      }
      r.classError = e.message;
    }
  }
  if (addedByClass.size > 0) {
    const batch = db.batch();
    const history = classHistoryCol(db, academyId);
    for (const [classId, studentIds] of addedByClass) {
      const className = classes.find((c) => c.id === classId)?.name ?? "";
      batch.set(history.doc(), classHistoryEntry({
        classId, className, type: "students_added", actorUid: callerUid, studentIds,
      }));
    }
    await batch.commit();
  }

  const createdCount = results.filter((r) => r.ok).length;
  logger.info("createStudentsBulk", {
    academyId,
    rows: rows.length,
    created: createdCount,
    failed: rows.length - createdCount,
    classAssigned: results.filter((r) => r.ok && r.classAssigned).length,
    ms: Date.now() - startedAt,
  });
  return { ok: true as const, results, createdCount, failedCount: rows.length - createdCount };
});
