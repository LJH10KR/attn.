import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { assertPermission } from "./lib/academy-access";
import { academySeqMetaPath, formatParentAttnId } from "./lib/attn-id";
import { assertKrPhoneRequired } from "./lib/kr-phone";
import { provisionMemberAccount } from "./lib/member-credentials";
import {
  claimParentPhoneIndexInTx,
  deleteParentAccountData,
  linkParentToStudentTx,
  parentDocRef,
  parentLinkTargetViolation,
  parentPhoneIndexRef,
  PARENT_PHONE_TAKEN_MSG,
  unlinkParentFromStudentTx,
  type LinkTarget,
} from "./lib/parent-links";

/**
 * 운영 › 학부모 관리 — 학부모 앱 계정과 원생 보호자 연결(승인·직접 연결·해제·직접 만들어 주기).
 * 학부모 요약·상태 자동 전환·결제 `parentUids`는 학생 트리거(`onAcademyStudentParentLinksWritten`)가 맞춘다.
 */

const MAX_LINK_STUDENTS = 20;

function requireId(raw: unknown, message = "요청이 올바르지 않습니다."): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.includes("/")) {
    throw new HttpsError("invalid-argument", message);
  }
  return s;
}

function parseStudentIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpsError("invalid-argument", "연결할 원생을 선택해 주세요.");
  }
  const ids = [...new Set(raw.map((x) => requireId(x, "원생 정보가 올바르지 않습니다.")))];
  if (ids.length > MAX_LINK_STUDENTS) {
    throw new HttpsError("invalid-argument", `한 번에 ${MAX_LINK_STUDENTS}명까지 연결할 수 있습니다.`);
  }
  return ids;
}

type LinkFailure = { studentId: string; message: string };

/** 학생마다 트랜잭션으로 연결 — 실패한 학생은 이유와 함께 돌려준다(나머지는 진행) */
async function linkStudents(
  db: admin.firestore.Firestore,
  academyId: string,
  target: LinkTarget,
  studentIds: readonly string[],
): Promise<{ linked: string[]; alreadyLinked: string[]; failures: LinkFailure[] }> {
  const linked: string[] = [];
  const alreadyLinked: string[] = [];
  const failures: LinkFailure[] = [];
  for (const studentId of studentIds) {
    try {
      const r = await linkParentToStudentTx(db, academyId, target, studentId);
      (r === "linked" ? linked : alreadyLinked).push(studentId);
    } catch (e) {
      if (!(e instanceof HttpsError)) throw e;
      failures.push({ studentId, message: e.message });
    }
  }
  return { linked, alreadyLinked, failures };
}

/**
 * 승인·직접 연결 — 계정(승인 대기·사용 중·첫 로그인 전)을 원생들의 보호자에 연결.
 * 계정의 번호 색인을 먼저 잡고(다른 계정이 잡은 번호면 거부), 첫 연결이면 `approvedAt`을 기록한다.
 */
export const linkParentToStudents = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const callerUid = request.auth.uid;
  const academyId = requireId(request.data?.academyId, "학원 ID가 필요합니다.");
  const parentUid = requireId(request.data?.parentUid);
  const studentIds = parseStudentIds(request.data?.studentIds);

  const db = admin.firestore();
  await assertPermission(db, academyId, callerUid, request.auth.token, "operations.parents");

  const ref = parentDocRef(db, academyId, parentUid);
  const target = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError("not-found", "학부모 계정을 찾을 수 없습니다.");
    }
    const violation = parentLinkTargetViolation(snap.get("status"));
    if (violation) {
      throw new HttpsError("failed-precondition", violation);
    }
    const phoneRaw = snap.get("phone");
    if (typeof phoneRaw !== "string" || !phoneRaw.trim()) {
      throw new HttpsError("failed-precondition", "계정에 휴대폰 번호가 없습니다.");
    }
    const phone = assertKrPhoneRequired(phoneRaw);
    const writeIndex = await claimParentPhoneIndexInTx(tx, db, academyId, phone, parentUid);
    writeIndex();
    const displayName = snap.get("displayName");
    return {
      uid: parentUid,
      phone,
      displayName: typeof displayName === "string" ? displayName.trim() : "",
      approved: snap.get("approvedAt") != null,
    };
  });

  const result = await linkStudents(db, academyId, target, studentIds);
  if (!target.approved && result.linked.length + result.alreadyLinked.length > 0) {
    await ref.update({
      approvedAt: FieldValue.serverTimestamp(),
      approvedByUid: callerUid,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  return { ok: true as const, ...result };
});

/** 원생 1명에서 계정 연결만 해제(보호자 연락처·계정은 남김) */
export const unlinkParentFromStudent = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireId(request.data?.academyId, "학원 ID가 필요합니다.");
  const parentUid = requireId(request.data?.parentUid);
  const studentId = requireId(request.data?.studentId);

  const db = admin.firestore();
  await assertPermission(db, academyId, request.auth.uid, request.auth.token, "operations.parents");

  const changed = await unlinkParentFromStudentTx(db, academyId, parentUid, studentId);
  return { ok: true as const, changed };
});

/**
 * 직접 만들어 주기 — 이름·번호로 계정(첫 로그인 전, 임시 비밀번호 한 번 표시)을 만들고 원생들에 연결.
 * 번호를 다른 계정이 이미 잡고 있으면 거부(만든 뒤 경합에서 지면 만든 계정을 지운다).
 */
export const createParentAccount = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const callerUid = request.auth.uid;
  const academyId = requireId(request.data?.academyId, "학원 ID가 필요합니다.");
  const displayName = typeof request.data?.displayName === "string" ? request.data.displayName.trim() : "";
  if (!displayName || displayName.length > 60) {
    throw new HttpsError("invalid-argument", "이름을 1~60자로 입력해 주세요.");
  }
  const phone = assertKrPhoneRequired(request.data?.phone);
  const studentIds = parseStudentIds(request.data?.studentIds);

  const db = admin.firestore();
  await assertPermission(db, academyId, callerUid, request.auth.token, "operations.parents");

  const studentSnaps = await db.getAll(
    ...studentIds.map((id) => db.doc(`academies/${academyId}/students/${id}`)),
  );
  if (studentSnaps.some((s) => !s.exists)) {
    throw new HttpsError("not-found", "원생 정보를 찾을 수 없습니다.");
  }
  if ((await parentPhoneIndexRef(db, academyId, phone).get()).exists) {
    throw new HttpsError("already-exists", PARENT_PHONE_TAKEN_MSG);
  }

  const attnId = await db.runTransaction(async (tx) => {
    const seqRef = db.doc(academySeqMetaPath(academyId));
    const seqSnap = await tx.get(seqRef);
    const next = (seqSnap.get("nextParentSeq") as number) || 1;
    tx.set(seqRef, { nextParentSeq: next + 1 }, { merge: true });
    return formatParentAttnId(academyId, next);
  });

  let member;
  try {
    member = await provisionMemberAccount({
      db,
      academyId,
      attnId,
      role: "parent",
      displayName,
      extra: {
        loginId: attnId,
        phone,
        authProvider: "password",
        signupSource: "academy_created",
        linkedStudentIds: [],
        approvedAt: FieldValue.serverTimestamp(),
        approvedByUid: callerUid,
      },
    });
  } catch (e) {
    logger.error("createParentAccount: provision failed", { academyId, e });
    throw new HttpsError("internal", "계정을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }

  try {
    await db.runTransaction(async (tx) => {
      const writeIndex = await claimParentPhoneIndexInTx(tx, db, academyId, phone, member.authUid);
      writeIndex();
    });
  } catch (e) {
    // 같은 번호로 동시에 만든 계정에 졌으면 방금 만든 계정을 되돌린다
    await deleteParentAccountData(db, academyId, member.authUid).catch(() => undefined);
    await admin.auth().deleteUser(member.authUid).catch(() => undefined);
    throw e;
  }

  const result = await linkStudents(db, academyId, { uid: member.authUid, phone, displayName }, studentIds);
  return {
    ok: true as const,
    authUid: member.authUid,
    loginId: member.loginId,
    displayName: member.displayName,
    tempPassword: member.tempPassword,
    ...result,
  };
});
