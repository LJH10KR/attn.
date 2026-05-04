import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import type { DocumentReference } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

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

function randomPassword(): string {
  // Firebase Auth 패스워드 정책을 만족시키기 위한 형태(문자/숫자 혼합 포함)
  return crypto.randomBytes(24).toString("base64url") + "Aa1!";
}

function randomEmail(kind: SeedUserKind, academyId: string, idx: number, batchId: string): string {
  // 이메일 유니크 보장(배치/인덱스 포함)
  return `${kind}_${batchId}_${academyId}_${idx}@attn.test`;
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
  kind: SeedUserKind;
  academyId: string;
  idx: number;
  batchId: string;
}): Promise<{ uid: string; email: string; password: string; displayName: string }> {
  const password = randomPassword();
  const email = randomEmail(params.kind, params.academyId, params.idx, params.batchId);
  const displayName = randomDisplayName(params.kind, params.idx);

  const user = await admin.auth().createUser({
    email,
    password,
    displayName,
    emailVerified: true,
    disabled: false,
  });

  return { uid: user.uid, email, password, displayName };
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

  // teacherAssignedTeacherUidsListOk는 길이 <= 20 검증이므로, 여기서는 훨씬 더 보수적으로 제한
  if (teachersPerStudent > teachersCount) {
    throw new HttpsError("invalid-argument", "teachersPerStudent는 teachersCount보다 작거나 같아야 합니다.");
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
  const ownerAuth = await createAuthUser({
    kind: "owner",
    academyId,
    idx: 0,
    batchId,
  });

  const teacherAuths: Array<{ uid: string; email: string; password: string; displayName: string }> = [];
  for (let i = 0; i < teachersCount; i++) {
    teacherAuths.push(
      await createAuthUser({
        kind: "teacher",
        academyId,
        idx: i,
        batchId,
      }),
    );
  }

  const parentAuths: Array<{ uid: string; email: string; password: string; displayName: string }> = [];
  for (let i = 0; i < parentsCount; i++) {
    parentAuths.push(
      await createAuthUser({
        kind: "parent",
        academyId,
        idx: i,
        batchId,
      }),
    );
  }

  // 2) Firestore 시드(쓰기 수가 많지 않으므로 배치 단위 커밋)
  const portalPassword = randomPassword();
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

  // secrets/login (필요할 때만 사용되므로 랜덤 값)
  writes.push({
    ref: db.doc(`academies/${academyId}/secrets/login`),
    data: { portalPassword },
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

  // teachers
  for (const t of teacherAuths) {
    writes.push({
      ref: db.doc(`academies/${academyId}/teachers/${t.uid}`),
      data: {
        email: t.email,
        displayName: t.displayName,
        subject: null,
        phone: null,
        academyId,
        status: "active",
        authUid: t.uid,
        activatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
    });
  }

  // parents + students
  const parentStudentDocs: Array<{
    ref: DocumentReference;
    data: Record<string, unknown>;
  }> = [];

  for (let p = 0; p < parentAuths.length; p++) {
    const parent = parentAuths[p]!;

    writes.push({
      ref: db.doc(`academies/${academyId}/parents/${parent.uid}`),
      data: {
        email: parent.email,
        displayName: parent.displayName,
        phone: null,
        emergencyContact: null,
        childrenCount: studentsPerParent,
        academyId,
        status: "active",
        authUid: parent.uid,
        activatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
    });

    for (let s = 0; s < studentsPerParent; s++) {
      const studentId = `student_${p + 1}_${s + 1}`;
      const assigned: string[] = [];
      for (let k = 0; k < teachersPerStudent; k++) {
        const tidx = (p + s + k) % teacherAuths.length;
        assigned.push(teacherAuths[tidx]!.uid);
      }

      parentStudentDocs.push({
        ref: db.doc(`academies/${academyId}/students/${studentId}`),
        data: {
          parentUserId: parent.uid,
          name: `${parent.displayName} 자녀 ${s + 1}`,
          age: 7 + ((s + p) % 10),
          phone: "",
          emergencyContact: "",
          assignedTeacherUids: assigned,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
      });
    }
  }

  writes.push(
    ...parentStudentDocs.map((d) => ({
      ref: d.ref,
      data: d.data,
    })),
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
      parentUids: parentAuths.map((x) => x.uid),
      counts: { teachersCount, parentsCount, studentsPerParent, teachersPerStudent },
      deletedAt: null,
    },
  });

  // write commit in chunks to avoid 500 op limit
  const chunkSize = 400;
  const writeChunks = chunkArray(writes, chunkSize);
  for (const c of writeChunks) {
    const batch = db.batch();
    for (const w of c) batch.set(w.ref, w.data);
    await batch.commit();
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
      teachers: teacherAuths.map((t) => ({ email: t.email, password: t.password })),
      parents: parentAuths.map((p) => ({ email: p.email, password: p.password })),
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

  // Firestore 삭제
  const academyTeachersRef = db.collection(`academies/${academyId}/teachers`);
  const academyParentsRef = db.collection(`academies/${academyId}/parents`);
  const academyStudentsRef = db.collection(`academies/${academyId}/students`);
  const secretsLoginRef = db.doc(`academies/${academyId}/secrets/login`);
  const academyRef = db.doc(`academies/${academyId}`);

  const [teachersSnap, parentsSnap, studentsSnap, secretsSnap] = await Promise.all([
    academyTeachersRef.get(),
    academyParentsRef.get(),
    academyStudentsRef.get(),
    secretsLoginRef.get(),
  ]);

  const deleteOps: DocumentReference[] = [];
  teachersSnap.docs.forEach((d) => deleteOps.push(d.ref));
  parentsSnap.docs.forEach((d) => deleteOps.push(d.ref));
  studentsSnap.docs.forEach((d) => deleteOps.push(d.ref));
  if (secretsSnap.exists) deleteOps.push(secretsLoginRef);
  deleteOps.push(academyRef);

  const chunkSize = 400;
  for (const c of chunkArray(deleteOps, chunkSize)) {
    const batch = db.batch();
    for (const ref of c) batch.delete(ref);
    await batch.commit();
  }

  // Auth 삭제(삭제 실패는 무시: 이미 지워졌을 수 있음)
  const authUids = [ownerUid, ...teacherUids, ...parentUids].filter(Boolean);
  for (const uid of authUids) {
    try {
      await admin.auth().deleteUser(uid);
    } catch (e) {
      logger.warn("seedBatch deleteUser skipped", { uid, e });
    }
  }

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

