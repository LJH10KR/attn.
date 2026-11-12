import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import type { DocumentReference } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { DEFAULT_STAFF_ROLE_ID } from "./lib/permissions";
import {
  academySeqMetaPath,
  attnLoginIndexPath,
  formatParentAttnId,
  formatStudentAttnId,
  formatTeacherAttnId,
} from "./lib/attn-id";
import { deleteAcademyCompletely } from "./lib/academy-delete";
import { releaseDeletedAcademyMembers } from "./lib/admin-user-cleanup";
import { internalEmailForAttnId, randomAuthPassword } from "./lib/member-credentials";
import { passwordSecretFields } from "./lib/password-hash";
import { allocateTeacherLoginId } from "./lib/teacher-login-id";
import { deriveGuardianFields, type Guardian } from "./lib/student-guardians";
import { classesCol, classHistoryCol, classHistoryEntry, computeTeacherUids } from "./lib/class-teachers";
import { kstYear, type GradeCode, type StudentStatus } from "./lib/student-profile";
import { academyOptionsRef, DEFAULT_GUARDIAN_RELATIONS } from "./academy-options";
import { ensureAcademyRoleTemplates } from "./roles";

const SEED_GRADES: readonly GradeCode[] = ["e1", "e3", "e5", "m2", "h1", "preschool"];
/** 재원 위주 + 휴원·미등록·퇴원 하나씩 — 상태 제외 확인용 */
const SEED_STATUSES: readonly StudentStatus[] = [
  "enrolled", "enrolled", "on_leave", "enrolled", "prospect", "enrolled", "withdrawn",
];

if (!admin.apps.length) {
  admin.initializeApp();
}

type SeedUserKind = "owner" | "teacher" | "parent";

function assertAdmin(request: { auth?: { uid: string; token?: Record<string, unknown> } | null }): void {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const isAdmin = request.auth?.token && request.auth.token.admin === true;
  if (!isAdmin) {
    throw new HttpsError("permission-denied", "관리자 권한이 없습니다.");
  }
}

function normalizeNewAcademyId(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function validateNewAcademySlug(academyId: string): void {
  // createAcademyWithPortal과 동일 제약
  if (!/^[a-z0-9][a-z0-9_-]{1,47}$/.test(academyId)) {
    throw new HttpsError(
      "invalid-argument",
      "학원 ID는 3~48자이며 영문 소문자, 숫자, 밑줄(_), 하이픈(-)만 사용할 수 있습니다.",
    );
  }
}

/** 테스트 시드 계정 전용 고정 비밀번호(로그인 테스트 편의) — 원장은 이메일, 직원·학부모는 로그인 ID 비밀번호 */
const SEED_PASSWORD = "Atn1234!";

function randomPassword(): string {
  return SEED_PASSWORD;
}

type SeedMember = {
  uid: string;
  attnId: string;
  loginId: string;
  displayName: string;
};

/**
 * seed 직원·학부모 — 실제 계정과 같은 로그인 ID 계정(내부 이메일, Auth 비밀번호 무작위).
 * 로그인은 로그인 ID + `SEED_PASSWORD`(`secrets/login` 해시)로만 된다. 문서·색인은 호출 측 배치에서 쓴다.
 */
async function createSeedMemberAuth(attnId: string, displayName: string, loginId: string): Promise<SeedMember> {
  const user = await admin.auth().createUser({
    email: internalEmailForAttnId(attnId),
    password: randomAuthPassword(),
    displayName,
    emailVerified: false,
    disabled: false,
  });
  return { uid: user.uid, attnId, loginId, displayName };
}

/** seed 멤버의 로그인 비밀번호·로그인 색인 쓰기 */
async function seedMemberLoginWrites(
  db: FirebaseFirestore.Firestore,
  academyId: string,
  role: "teacher" | "parent",
  m: SeedMember,
): Promise<Array<{ ref: DocumentReference; data: Record<string, unknown> }>> {
  const col = role === "teacher" ? "staff" : "parents";
  return [
    {
      ref: db.doc(`academies/${academyId}/${col}/${m.uid}/secrets/login`),
      data: {
        ...(await passwordSecretFields(SEED_PASSWORD)),
        authProvider: "password",
        updatedAt: FieldValue.serverTimestamp(),
      },
    },
    {
      ref: db.doc(attnLoginIndexPath(m.loginId)),
      data: {
        loginId: m.loginId,
        attnId: m.attnId,
        academyId,
        authUid: m.uid,
        role,
        ...(role === "parent" ? { authProvider: "password" } : {}),
        createdAt: FieldValue.serverTimestamp(),
      },
    },
  ];
}

function randomEmail(kind: SeedUserKind, seqNo: number): string {
  // 가독성 우선: owner1@example.com, teacher12@example.com, parent5@example.com
  return `${kind}${seqNo}@example.com`;
}

function randomDisplayName(kind: SeedUserKind, idx: number): string {
  switch (kind) {
  case "owner":
    return `테스트 오너 ${idx + 1}`;
  case "teacher":
    return `테스트 선생님 ${idx + 1}`;
  case "parent":
    return `테스트 학부모 ${idx + 1}`;
  default:
    return `테스트 사용자 ${idx + 1}`;
  }
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function chunkArray<T>(arr: T[], chunkSize: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize) out.push(arr.slice(i, i + chunkSize));
  return out;
}

async function createAuthUser(params: {
  db: FirebaseFirestore.Firestore;
  kind: SeedUserKind;
  seqNo: number;
  displayIdx: number;
}): Promise<{ uid: string; email: string; password: string; displayName: string }> {
  const password = randomPassword();
  const displayName = randomDisplayName(params.kind, params.displayIdx);
  let seqNo = params.seqNo;

  for (let attempt = 0; attempt < 5; attempt++) {
    const email = randomEmail(params.kind, seqNo);
    try {
      const user = await admin.auth().createUser({
        email,
        password,
        displayName,
        emailVerified: true,
        disabled: false,
      });
      return { uid: user.uid, email, password, displayName };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "auth/email-already-exists") {
        throw e;
      }
      // 드물게 기존 수동 계정과 충돌 시 다음 번호를 즉시 예약해 재시도
      seqNo = await reserveNextSeedNumber(params.db, params.kind);
    }
  }
  throw new HttpsError("resource-exhausted", "테스트 계정 번호 할당에 반복 충돌이 발생했습니다.");
}

async function reserveSeedNumberRange(
  db: FirebaseFirestore.Firestore,
  kind: SeedUserKind,
  count: number,
): Promise<number[]> {
  return db.runTransaction(async (tx) => {
    const ref = db.doc(`seedCounters/${kind}`);
    const snap = await tx.get(ref);
    const current = snap.get("nextNumber");
    const nextNumber =
      typeof current === "number" && Number.isInteger(current) && current > 0 ? current : 1;
    tx.set(
      ref,
      {
        nextNumber: nextNumber + count,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return Array.from({ length: count }, (_, i) => nextNumber + i);
  });
}

async function reserveNextSeedNumber(
  db: FirebaseFirestore.Firestore,
  kind: SeedUserKind,
): Promise<number> {
  const [n] = await reserveSeedNumberRange(db, kind, 1);
  return n!;
}

/**
 * /admin에서 Google 소셜 로그인을 허용하되, admin이 아닌 계정은 로그인 직후
 * 거부(필요 시 방금 생성된 계정 삭제)합니다.
 *
 * - admin claim이 있으면 ok=true
 * - admin claim이 없으면
 *   - 가입(creationTime)이 최근(예: 2분 이내)인 계정은 삭제하여 “계정 생성”을 실질적으로 막습니다.
 *   - 오래된 계정은 삭제하지 않고 ok=false만 반환합니다.
 */
export const enforceAdminLogin = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }

  const token = request.auth?.token;
  const isAdmin = Boolean(token && (token as Record<string, unknown>).admin === true);
  if (isAdmin) {
    return { ok: true as const, deleted: false };
  }

  const userRecord = await admin.auth().getUser(uid);
  const creationTime = userRecord.metadata.creationTime;
  const createdAtMs = creationTime ? Date.parse(creationTime) : null;
  const ageMs =
    createdAtMs != null && Number.isFinite(createdAtMs)
      ? Date.now() - createdAtMs
      : null;

  const DELETE_IF_CREATED_WITHIN_MS = 2 * 60 * 1000;
  const shouldDelete = ageMs != null && ageMs <= DELETE_IF_CREATED_WITHIN_MS;
  if (shouldDelete) {
    await admin.auth().deleteUser(uid);
  }

  return {
    ok: false as const,
    deleted: shouldDelete,
  };
});

export const createSeedBatch = onCall(async (request) => {
  assertAdmin(
    request as unknown as { auth?: { uid: string; token?: Record<string, unknown> } | null },
  );
  const createdByUid = request.auth!.uid;

  const label =
    typeof request.data?.label === "string" ? request.data.label.trim().slice(0, 80) : "test-batch";
  const providedAcademyId = normalizeNewAcademyId(request.data?.academyId);

  // 안전 상한: 운영 데이터 영향 + 과금/제한 고려
  const teachersCount = clampInt(request.data?.teachersCount, 3, 1, 10);
  const parentsCount = clampInt(request.data?.parentsCount, 3, 1, 10);
  const studentsPerParent = clampInt(request.data?.studentsPerParent, 3, 1, 10);
  const teachersPerStudent = clampInt(request.data?.teachersPerStudent, 2, 1, 5);

  // 반당 선생님 수(입력 이름은 예전 그대로 teachersPerStudent)
  if (teachersPerStudent > teachersCount) {
    throw new HttpsError("invalid-argument", "반당 선생님 수는 선생님 수보다 클 수 없습니다.");
  }

  // batchId는 이메일/문서 id 구성에 들어가므로 고정 길이 + 유니크 보장
  const batchId =
    typeof request.data?.batchId === "string" && request.data.batchId.trim().length > 0
      ? request.data.batchId.trim().slice(0, 40)
      : `batch_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

  let academyId = providedAcademyId;
  if (academyId) {
    validateNewAcademySlug(academyId);
  } else {
    // label 기반 + 랜덤으로 생성
    const base = label
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 16)
      .replace(/^-|-$|_$/g, "");
    academyId = `${base || "attn"}_${batchId.split("_").slice(-1)[0]}`.slice(0, 48);
    validateNewAcademySlug(academyId);
  }

  const db = admin.firestore();
  const academyRef = db.doc(`academies/${academyId}`);
  const academySnap = await academyRef.get();
  if (academySnap.exists) {
    throw new HttpsError("already-exists", "동일한 학원 ID가 이미 존재합니다.");
  }

  // 1) Auth 유저 생성(UID 확보가 필요)
  // 번호는 seedCounters 트랜잭션으로 예약하므로 전체 스캔 없이 저비용으로 유니크 보장
  // 원장은 이메일 로그인(seedCounters 번호), 직원·학부모는 로그인 ID 계정(학원 meta/seq 번호)
  const [ownerNo] = await reserveSeedNumberRange(db, "owner", 1);
  // 학부모 번호(보호자 연락처)를 배치마다 다르게 만드는 데만 쓴다
  const parentNos = await reserveSeedNumberRange(db, "parent", parentsCount);

  const ownerAuth = await createAuthUser({
    db,
    kind: "owner",
    seqNo: ownerNo!,
    displayIdx: 0,
  });

  const teacherAuths: SeedMember[] = [];
  const usedTeacherLoginIds = new Set<string>();
  for (let i = 0; i < teachersCount; i++) {
    let loginId = await allocateTeacherLoginId(db);
    while (usedTeacherLoginIds.has(loginId)) loginId = await allocateTeacherLoginId(db);
    usedTeacherLoginIds.add(loginId);
    teacherAuths.push(
      await createSeedMemberAuth(
        formatTeacherAttnId(academyId, i + 1),
        randomDisplayName("teacher", i),
        loginId,
      ),
    );
  }

  const parentAuths: SeedMember[] = [];
  for (let i = 0; i < parentsCount; i++) {
    const attnId = formatParentAttnId(academyId, i + 1);
    parentAuths.push(await createSeedMemberAuth(attnId, randomDisplayName("parent", i), attnId));
  }

  // 2) Firestore 시드(쓰기 수가 많지 않으므로 배치 단위 커밋)
  const writes: Array<{
    ref: DocumentReference;
    data: Record<string, unknown>;
  }> = [];

  // academy doc
  writes.push({
    ref: academyRef,
    data: {
      ownerUid: ownerAuth.uid,
      name: `${label}`,
      createdAt: FieldValue.serverTimestamp(),
      status: "active",
    },
  });

  // owner profile
  writes.push({
    ref: db.doc(`users/${ownerAuth.uid}`),
    data: {
      email: ownerAuth.email,
      displayName: ownerAuth.displayName,
      photoURL: null,
      platformRole: "owner",
      emailVerified: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ownerOnboardedAt: FieldValue.serverTimestamp(),
    },
  });

  // teachers — 로그인 ID 계정(기본 역할 "선생님", 사용 중)
  for (const t of teacherAuths) {
    writes.push({
      ref: db.doc(`academies/${academyId}/staff/${t.uid}`),
      data: {
        attnId: t.attnId,
        loginId: t.loginId,
        email: "",
        displayName: t.displayName,
        subject: null,
        phone: null,
        academyId,
        status: "active",
        authUid: t.uid,
        authProvider: "password",
        isGuest: false,
        roleId: DEFAULT_STAFF_ROLE_ID,
        permissions: [],
        employmentStatus: "employed",
        activatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
    });
    writes.push(...(await seedMemberLoginWrites(db, academyId, "teacher", t)));
  }

  // 반 3개 — 여러 명 반 2개(반당 선생님 teachersPerStudent명) + 1인 반 1개, 강의실 선택지 2개
  const pickTeachers = (start: number, n: number) =>
    Array.from({ length: n }, (_, k) => teacherAuths[(start + k) % teacherAuths.length]!.uid).sort();
  const seedClasses: Array<{ id: string; data: Record<string, unknown> }> = [
    {
      id: "class_a",
      data: {
        name: "A반", status: "active", roomId: "room1", capacity: 10, sortOrder: 0,
        schedule: [{ weekday: 1, start: "16:00", end: "17:30" }, { weekday: 3, start: "16:00", end: "17:30" }],
        teacherUids: pickTeachers(0, teachersPerStudent),
      },
    },
    {
      id: "class_b",
      data: {
        name: "B반", status: "active", roomId: "room2", capacity: null, sortOrder: 1,
        schedule: [{ weekday: 2, start: "18:00", end: "19:30" }, { weekday: 4, start: "18:00", end: "19:30" }],
        teacherUids: pickTeachers(1, teachersPerStudent),
      },
    },
    {
      id: "class_solo",
      data: {
        name: "1:1 지도", status: "active", roomId: null, capacity: 1, sortOrder: 2,
        schedule: [{ weekday: 5, start: "15:00", end: "16:00" }],
        teacherUids: pickTeachers(teacherAuths.length - 1, 1),
      },
    },
  ];
  const classById = new Map(seedClasses.map((c) => [c.id, c.data]));
  for (const c of seedClasses) {
    writes.push({
      ref: classesCol(db, academyId).doc(c.id),
      data: {
        ...c.data,
        endedAt: null,
        createdByUid: createdByUid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
    });
    writes.push({
      ref: classHistoryCol(db, academyId).doc(),
      data: classHistoryEntry({
        classId: c.id, className: String(c.data.name), type: "created", actorUid: createdByUid,
      }),
    });
  }

  // parents + students
  const parentStudentDocs: Array<{
    ref: DocumentReference;
    data: Record<string, unknown>;
  }> = [];

  let studentSeq = 0;
  for (let p = 0; p < parentAuths.length; p++) {
    const parent = parentAuths[p]!;

    // 보호자 번호 — 원생 guardians와 같은 번호로 연결(형제는 같은 보호자)
    const parentPhone = `010-9${String(p + 1).padStart(3, "0")}-${String(parentNos[p]! % 10000).padStart(4, "0")}`;
    writes.push({
      ref: db.doc(`academies/${academyId}/parents/${parent.uid}`),
      data: {
        attnId: parent.attnId,
        loginId: parent.loginId,
        email: "",
        displayName: parent.displayName,
        phone: parentPhone,
        academyId,
        status: "active",
        authUid: parent.uid,
        authProvider: "password",
        signupSource: "academy_created",
        linkedStudentIds: Array.from({ length: studentsPerParent }, (_, s) => `student_${p + 1}_${s + 1}`).sort(),
        approvedAt: FieldValue.serverTimestamp(),
        approvedByUid: createdByUid,
        activatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
    });
    // 연결된 계정의 번호 색인(같은 학원 번호 1개 = 연결 계정 1개)
    writes.push({
      ref: db.doc(`academies/${academyId}/parentPhones/${parentPhone.replace(/\D/g, "")}`),
      data: { parentUid: parent.uid, createdAt: FieldValue.serverTimestamp() },
    });
    writes.push(...(await seedMemberLoginWrites(db, academyId, "parent", parent)));

    for (let s = 0; s < studentsPerParent; s++) {
      const studentId = `student_${p + 1}_${s + 1}`;
      // A반·B반 번갈아, 맨 처음 원생은 1인 반도
      const classIds = [studentSeq % 2 === 0 ? "class_a" : "class_b", ...(studentSeq === 0 ? ["class_solo"] : [])];

      // 상태·학년을 섞어 둔다(재원 위주) — 두 번째 보호자는 앱 계정 없이 연락처만
      const guardians: Guardian[] = [
        {
          id: `g_seed${p + 1}a`,
          relationId: "mother",
          name: parent.displayName,
          phone: parentPhone,
          isPrimary: true,
          linkedParentUid: parent.uid,
        },
        ...(s === 0
          ? [{
            id: `g_seed${p + 1}b`,
            relationId: "father",
            name: null,
            phone: `010-8${String(p + 1).padStart(3, "0")}-${String(parentNos[p]! % 10000).padStart(4, "0")}`,
            isPrimary: false,
            linkedParentUid: null,
          }]
          : []),
      ];
      studentSeq += 1;
      parentStudentDocs.push({
        ref: db.doc(`academies/${academyId}/students/${studentId}`),
        data: {
          attnId: formatStudentAttnId(academyId, studentSeq),
          name: `${parent.displayName} 자녀 ${s + 1}`,
          grade: SEED_GRADES[(p + s) % SEED_GRADES.length],
          gradeYear: kstYear(),
          school: null,
          phone: null,
          status: SEED_STATUSES[(p * studentsPerParent + s) % SEED_STATUSES.length],
          statusChangedAt: FieldValue.serverTimestamp(),
          firstAttendedOn: null,
          guardians,
          ...deriveGuardianFields(guardians),
          classIds,
          teacherUids: computeTeacherUids(classIds, classById),
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
      });
      if (s === 0) {
        parentStudentDocs.push({
          ref: db.doc(`academies/${academyId}/studentNotes/${studentId}`),
          data: { memo: "시드 메모 — 학원 내부용", updatedByUid: createdByUid, updatedAt: FieldValue.serverTimestamp() },
        });
      }
    }
  }

  // 승인 대기 학부모 2명 — 번호가 맞는 원생이 있는 계정(첫 학부모 첫 자녀의 연락처 전용 보호자 번호)과 매칭 없는 계정
  const pendingParents: Array<SeedMember & { phone: string }> = [];
  const pendingNos = await reserveSeedNumberRange(db, "parent", 2);
  for (let i = 0; i < 2; i++) {
    const attnId = formatParentAttnId(academyId, parentsCount + i + 1);
    const a = await createSeedMemberAuth(attnId, randomDisplayName("parent", parentsCount + i), attnId);
    const phone =
      i === 0
        ? `010-8001-${String(parentNos[0]! % 10000).padStart(4, "0")}`
        : `010-7${String(i).padStart(3, "0")}-${String(pendingNos[i]! % 10000).padStart(4, "0")}`;
    pendingParents.push({ ...a, phone });
    // 자가 가입 + 이메일 인증을 마친 승인 대기 계정과 같은 모양
    writes.push({
      ref: db.doc(`academies/${academyId}/parents/${a.uid}`),
      data: {
        attnId: a.attnId,
        loginId: a.loginId,
        email: "",
        displayName: a.displayName,
        phone,
        academyId,
        status: "pending_approval",
        authUid: a.uid,
        authProvider: "password",
        contactEmailVerified: true,
        linkedStudentIds: [],
        approvedAt: null,
        approvedByUid: null,
        signupSource: "parent_link",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
    });
    writes.push(...(await seedMemberLoginWrites(db, academyId, "parent", a)));
  }

  writes.push(
    ...parentStudentDocs.map((d) => ({
      ref: d.ref,
      data: d.data,
    })),
  );

  writes.push(
    {
      ref: db.doc(academySeqMetaPath(academyId)),
      data: {
        nextTeacherSeq: teachersCount + 1,
        nextParentSeq: parentsCount + pendingParents.length + 1,
        nextStudentSeq: studentSeq + 1,
      },
    },
    {
      ref: academyOptionsRef(db, academyId),
      data: {
        guardianRelations: DEFAULT_GUARDIAN_RELATIONS,
        rooms: [{ id: "room1", label: "1강의실" }, { id: "room2", label: "2강의실" }],
        updatedAt: FieldValue.serverTimestamp(),
      },
    },
  );

  // seedBatch metadata
  writes.push({
    ref: db.collection("seedBatches").doc(batchId),
    data: {
      batchId,
      label,
      createdByUid,
      createdAt: FieldValue.serverTimestamp(),
      academyId,
      ownerUid: ownerAuth.uid,
      teacherUids: teacherAuths.map((x) => x.uid),
      parentUids: [...parentAuths, ...pendingParents].map((x) => x.uid),
      counts: { teachersCount, parentsCount, studentsPerParent, teachersPerStudent },
      deletedAt: null,
    },
  });

  // write commit in chunks to avoid 500 op limit
  const chunkSize = 400;
  const writeChunks = chunkArray(writes, chunkSize);
  for (const c of writeChunks) {
    const batch = db.batch();
    // merge — 비밀번호 해시 필드(`passwordSecretFields`)가 FieldValue.delete()를 담고 있음(새 문서라 결과는 같음)
    for (const w of c) batch.set(w.ref, w.data, { merge: true });
    await batch.commit();
  }
  await ensureAcademyRoleTemplates(db, academyId);

  // 로그인 판단용 클레임(로그인 ID 로그인 때도 다시 씀)
  for (const t of teacherAuths) {
    await admin.auth().setCustomUserClaims(t.uid, { role: "teacher", academyId, membershipStatus: "active" });
  }
  for (const p of parentAuths) {
    await admin.auth().setCustomUserClaims(p.uid, { role: "parent", academyId, membershipStatus: "active" });
  }
  for (const p of pendingParents) {
    await admin.auth().setCustomUserClaims(p.uid, {
      role: "parent",
      academyId,
      membershipStatus: "pending_approval",
    });
  }

  logger.info("seedBatch created", {
    batchId,
    academyId,
    createdByUid,
    teachersCount,
    parentsCount,
    studentsPerParent,
  });

  return {
    ok: true as const,
    seedBatchId: batchId,
    academyId,
    credentials: {
      owner: { email: ownerAuth.email, password: ownerAuth.password },
      teachers: teacherAuths.map((t) => ({ loginId: t.loginId, password: SEED_PASSWORD, displayName: t.displayName })),
      parents: parentAuths.map((p) => ({ loginId: p.loginId, password: SEED_PASSWORD, displayName: p.displayName })),
      pendingParents: pendingParents.map((p) => ({
        loginId: p.loginId,
        password: SEED_PASSWORD,
        displayName: p.displayName,
        phone: p.phone,
      })),
    },
    hint: {
      ownerLoginUrl: "/login/owner",
      teacherLoginUrl: "/login/teacher",
      parentLoginUrl: "/login/parent",
    },
  };
});

export const deleteSeedBatch = onCall(async (request) => {
  assertAdmin(
    request as unknown as { auth?: { uid: string; token?: Record<string, unknown> } | null },
  );
  const callerUid = request.auth!.uid;
  const seedBatchId =
    typeof request.data?.seedBatchId === "string" ? request.data.seedBatchId.trim() : "";
  if (!seedBatchId) {
    throw new HttpsError("invalid-argument", "seedBatchId를 입력해 주세요.");
  }

  const db = admin.firestore();
  const batchRef = db.collection("seedBatches").doc(seedBatchId);
  const snap = await batchRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "해당 seed 배치를 찾을 수 없습니다.");
  }

  const data = snap.data() as {
    createdByUid?: string;
    academyId?: string;
    ownerUid?: string;
    teacherUids?: string[];
    parentUids?: string[];
    deletedAt?: unknown;
  };

  if (data.createdByUid !== callerUid) {
    // admin claim이어도 자기 배치만 삭제(혼선 방지)
    throw new HttpsError("permission-denied", "이 배치는 삭제 권한이 없습니다.");
  }
  if (data.deletedAt) {
    return { ok: true as const, alreadyDeleted: true };
  }
  const academyId = typeof data.academyId === "string" ? data.academyId : "";
  const ownerUid = typeof data.ownerUid === "string" ? data.ownerUid : "";
  const teacherUids = Array.isArray(data.teacherUids) ? (data.teacherUids as string[]) : [];
  const parentUids = Array.isArray(data.parentUids) ? (data.parentUids as string[]) : [];

  if (!academyId || !ownerUid) {
    throw new HttpsError("failed-precondition", "seed 배치 메타데이터가 올바르지 않습니다.");
  }

  // 학원 삭제와 같은 전체 정리(2-N — 결제 기록 포함, 멤버·원장 Auth는 다른 쓰임이 없을 때만, admin 계정 제외)
  await deleteAcademyCompletely(db, academyId, {
    ownerAccount: "delete_if_unused",
    context: "deleteSeedBatch",
    requestedBy: callerUid,
    ownerUidHint: ownerUid,
  });
  // 배치에 적힌 계정 중 학원 문서에 없던 것(만들다 멈춘 계정 등)도 같은 판단으로
  await releaseDeletedAcademyMembers(db, {
    memberAuthUids: [...teacherUids, ...parentUids],
    ownerUid,
    context: "deleteSeedBatch",
  });

  await batchRef.update({ deletedAt: FieldValue.serverTimestamp() });

  logger.info("seedBatch deleted", { seedBatchId, academyId, deletedBy: callerUid });
  return { ok: true as const };
});

export const listSeedBatches = onCall(async (request) => {
  assertAdmin(
    request as unknown as { auth?: { uid: string; token?: Record<string, unknown> } | null },
  );
  const callerUid = request.auth!.uid;

  const limit = clampInt(request.data?.limit, 10, 1, 20);
  const db = admin.firestore();

  const snaps = await db
    .collection("seedBatches")
    .where("createdByUid", "==", callerUid)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  return {
    ok: true as const,
    batches: snaps.docs.map((d) => {
      const x = d.data() as {
        label?: unknown;
        academyId?: unknown;
        counts?: unknown;
        createdAt?: unknown;
        deletedAt?: unknown;
      };
      return {
        seedBatchId: d.id,
        label: typeof x.label === "string" ? x.label : "",
        academyId: typeof x.academyId === "string" ? x.academyId : "",
        counts: typeof x.counts === "object" ? (x.counts as Record<string, unknown>) : null,
        createdAtMillis:
          x.createdAt && typeof (x.createdAt as { toMillis?: unknown }).toMillis === "function"
            ? (x.createdAt as { toMillis: () => number }).toMillis()
            : null,
        deletedAt: Boolean(x.deletedAt),
      };
    }),
  };
});

