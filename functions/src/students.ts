import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { academyOptionsRef, readOptionItems } from "./academy-options";
import { assertPermission } from "./lib/academy-access";
import { academySeqMetaPath, formatStudentAttnId } from "./lib/attn-id";
import { deleteStudentDocs } from "./lib/firestore-cleanup";
import { parseOptionalKrPhone } from "./lib/kr-phone";
import {
  deriveGuardianFields,
  parseGuardiansInput,
  readGuardians,
} from "./lib/student-guardians";
import {
  displayGrade,
  isGradeCode,
  isStudentStatus,
  kstYear,
  type GradeCode,
  type StudentStatus,
} from "./lib/student-profile";

/**
 * 운영 › 원생 관리 — `academies/{academyId}/students/{studentId}`의 원생 정보.
 * 원생은 학부모 계정 없이 먼저 존재하고, 보호자는 `guardians[]` 연락처 목록이다.
 * 학생 문서의 클라이언트 생성·원생 정보 수정은 규칙에서 막혀 있으며 이 함수들만 쓴다.
 * 파생 필드(`guardianPhones`·`parentUids`·`teacherUids`)와 `classIds`·`linkedParentUid`는 받지 않는다.
 * 학원 내부 메모는 학부모가 읽는 학생 문서가 아니라 `studentNotes/{studentId}`에 둔다.
 * 원비·회차 필드는 4단계까지 기존 화면이 규칙 범위 안에서 직접 쓴다.
 */

const MAX_NAME_LENGTH = 40;
const MAX_SCHOOL_LENGTH = 40;
const MAX_MEMO_LENGTH = 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireString(raw: unknown, message: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.includes("/")) {
    throw new HttpsError("invalid-argument", message);
  }
  return s;
}

/** "YYYY-MM-DD" 또는 빈 값 — 실존 날짜만 */
function parseOptionalDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || !DATE_RE.test(raw)) {
    throw new HttpsError("invalid-argument", "최초 등원일 형식이 올바르지 않습니다.");
  }
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    throw new HttpsError("invalid-argument", "최초 등원일 형식이 올바르지 않습니다.");
  }
  return raw;
}

function parseStatus(raw: unknown): StudentStatus {
  if (isStudentStatus(raw)) return raw;
  throw new HttpsError("invalid-argument", "원생 상태가 올바르지 않습니다.");
}

/**
 * 화면은 "지금 보이는 학년"을 보낸다. 저장 값의 표시 학년과 같으면 저장 값(기준 연도 포함)을 그대로 두고,
 * 바뀌었으면 보낸 학년을 올해 기준으로 저장한다. 졸업은 저장 값이 졸업으로 보일 때만 그대로 받는다.
 */
function resolveGrade(
  raw: unknown,
  stored: { grade: unknown; gradeYear: unknown } | null,
  nowYear: number,
): { grade: GradeCode; gradeYear: number } {
  if (stored && isGradeCode(stored.grade) && typeof stored.gradeYear === "number") {
    if (raw === displayGrade(stored.grade, stored.gradeYear, nowYear)) {
      return { grade: stored.grade, gradeYear: stored.gradeYear };
    }
  }
  if (!isGradeCode(raw)) {
    throw new HttpsError("invalid-argument", "학년을 선택해 주세요.");
  }
  return { grade: raw, gradeYear: nowYear };
}

/** 원생 추가(studentId 없음)·수정 */
export const saveStudent = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const callerUid = request.auth.uid;
  const academyId = requireString(request.data?.academyId, "학원 ID가 필요합니다.");
  const studentIdRaw = request.data?.studentId;
  const studentId =
    studentIdRaw === undefined || studentIdRaw === null || studentIdRaw === ""
      ? null
      : requireString(studentIdRaw, "원생 정보가 올바르지 않습니다.");

  const name = typeof request.data?.name === "string" ? request.data.name.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new HttpsError("invalid-argument", `이름을 1~${MAX_NAME_LENGTH}자로 입력해 주세요.`);
  }
  const school = typeof request.data?.school === "string" ? request.data.school.trim() : "";
  if (school.length > MAX_SCHOOL_LENGTH) {
    throw new HttpsError("invalid-argument", `학교는 ${MAX_SCHOOL_LENGTH}자 이하로 입력해 주세요.`);
  }
  const phone = parseOptionalKrPhone(request.data?.phone);
  const status = parseStatus(request.data?.status ?? "enrolled");
  const firstAttendedOn = parseOptionalDate(request.data?.firstAttendedOn);
  const memoRaw = request.data?.memo;
  const memo = typeof memoRaw === "string" ? memoRaw.trim() : null;
  if (memo !== null && memo.length > MAX_MEMO_LENGTH) {
    throw new HttpsError("invalid-argument", `메모는 ${MAX_MEMO_LENGTH}자 이하로 입력해 주세요.`);
  }

  const db = admin.firestore();
  await assertPermission(db, academyId, callerUid, request.auth.token, "operations.students");

  const optionsSnap = await academyOptionsRef(db, academyId).get();
  const relationIds = new Set(readOptionItems(optionsSnap.get("guardianRelations")).map((o) => o.id));
  const nowYear = kstYear();
  const studentsCol = db.collection(`academies/${academyId}/students`);

  const profile = {
    name,
    school: school || null,
    phone,
    firstAttendedOn,
  };

  if (!studentId) {
    const guardians = parseGuardiansInput(request.data?.guardians, [], relationIds);
    const grade = resolveGrade(request.data?.grade, null, nowYear);
    const ref = studentsCol.doc();
    const attnId = await db.runTransaction(async (tx) => {
      const seqRef = db.doc(academySeqMetaPath(academyId));
      const seqSnap = await tx.get(seqRef);
      const next = (seqSnap.get("nextStudentSeq") as number) || 1;
      const newAttnId = formatStudentAttnId(academyId, next);
      tx.set(seqRef, { nextStudentSeq: next + 1 }, { merge: true });
      tx.create(ref, {
        attnId: newAttnId,
        ...profile,
        ...grade,
        status,
        statusChangedAt: FieldValue.serverTimestamp(),
        guardians,
        ...deriveGuardianFields(guardians),
        classIds: [],
        teacherUids: [],
        createdByUid: callerUid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (memo) {
        tx.set(db.doc(`academies/${academyId}/studentNotes/${ref.id}`), {
          memo,
          updatedByUid: callerUid,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      return newAttnId;
    });
    return { ok: true as const, studentId: ref.id, attnId };
  }

  const ref = studentsCol.doc(studentId);
  const attnId = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError("not-found", "원생 정보를 찾을 수 없습니다.");
    }
    // 연결(linkedParentUid)은 이 트랜잭션에서 읽은 값에서만 이어받는다
    const guardians = parseGuardiansInput(
      request.data?.guardians,
      readGuardians(snap.get("guardians")),
      relationIds,
    );
    const grade = resolveGrade(
      request.data?.grade,
      { grade: snap.get("grade"), gradeYear: snap.get("gradeYear") },
      nowYear,
    );
    const statusChanged = snap.get("status") !== status;
    tx.update(ref, {
      ...profile,
      ...grade,
      status,
      ...(statusChanged ? { statusChangedAt: FieldValue.serverTimestamp() } : {}),
      guardians,
      ...deriveGuardianFields(guardians),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (memo !== null) {
      tx.set(db.doc(`academies/${academyId}/studentNotes/${studentId}`), {
        memo,
        updatedByUid: callerUid,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    const existingAttnId = snap.get("attnId");
    return typeof existingAttnId === "string" ? existingAttnId : "";
  });
  return { ok: true as const, studentId, attnId };
});

/** 원생 삭제 — 학생 문서·하위 기록·메모 */
export const deleteAcademyStudent = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireString(request.data?.academyId, "요청이 올바르지 않습니다.");
  const studentId = requireString(request.data?.studentId, "요청이 올바르지 않습니다.");

  const db = admin.firestore();
  await assertPermission(db, academyId, request.auth.uid, request.auth.token, "operations.students");

  const snap = await db.doc(`academies/${academyId}/students/${studentId}`).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "학생 정보를 찾을 수 없습니다.");
  }

  await deleteStudentDocs(db, academyId, [studentId]);
  return { ok: true };
});
