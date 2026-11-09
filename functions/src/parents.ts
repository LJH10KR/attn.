import * as admin from "firebase-admin";
import { FieldValue, Timestamp, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { reconcileUserActivationMirror } from "./user-activation-mirror";
import { getRequireStudentCheckInPin } from "./kiosk";
import { loadNextDueInvoiceSummaries } from "./tuition-invoices";
import { assertPermission } from "./lib/academy-access";
import {
  displayGrade,
  gradeLabel,
  isBillableStudent,
  normalizeStudentStatus,
  type StudentStatus,
} from "./lib/student-profile";
import { purgeUserFirestoreData } from "./lib/firestore-cleanup";
import {
  authUidHasOtherMemberships,
  deleteParentAccountData,
  parentDocRef,
  parentStatusFromLinks,
  readLinkedStudentIdsInTx,
  type ParentAccountStatus,
} from "./lib/parent-links";

/**
 * 학부모 앱 계정(`academies/{academyId}/parents/{uid}`) — 진입 상태·자녀 목록·활성/비활성·삭제.
 * 원생 연결·직접 만들어 주기는 `parent-links.ts`. 상태는 `lib/parent-links.ts` `ParentAccountStatus`.
 */

function requireId(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.includes("/")) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }
  return s;
}


function studentCheckInSecretPath(academyId: string, studentId: string): string {
  return `academies/${academyId}/students/${studentId}/serverSecrets/checkIn`;
}

function serializeStudentDocForCallable(
  d: QueryDocumentSnapshot,
  opts?: { hasCheckInPin?: boolean },
): {
  id: string;
  name: string;
  /** 표시 학년 라벨(초3 등) — 학년 코드·기준 연도는 내려주지 않는다 */
  gradeLabel: string;
  status: StudentStatus;
  /** 청구 대상(재원)인지 — 결제 카드 노출 */
  billable: boolean;
  createdAtMillis: number | null;
  hasCheckInPin?: boolean;
  tuitionDueDayOfMonth: number | null;
  tuitionAmount: number | null;
  weeklySessionCount: number | null;
  pricePerSession: number | null;
  sessionBalance: number | null;
  extraSessionDates: string[];
  hasPendingPaymentReminder: boolean;
} {
  const data = d.data();
  const createdAt = data.createdAt as Timestamp | undefined;
  const createdAtMillis =
    createdAt && typeof createdAt.toMillis === "function" ? createdAt.toMillis() : null;
  const rawDay = data.tuitionDueDayOfMonth;
  const tuitionDueDayOfMonth =
    typeof rawDay === "number" && Number.isInteger(rawDay) && rawDay >= 1 && rawDay <= 31
      ? rawDay
      : null;
  const rawWeeklyCount = data.weeklySessionCount;
  const weeklySessionCount =
    typeof rawWeeklyCount === "number" && Number.isInteger(rawWeeklyCount) && rawWeeklyCount >= 1 && rawWeeklyCount <= 7
      ? rawWeeklyCount
      : null;
  const rawPrice = data.pricePerSession;
  const pricePerSession =
    typeof rawPrice === "number" && rawPrice >= 0 ? rawPrice : null;
  const rawBalance = data.sessionBalance;
  const sessionBalance =
    typeof rawBalance === "number" && Number.isInteger(rawBalance) ? rawBalance : null;
  const rawExtraDates = data.extraSessionDates;
  const extraSessionDates =
    Array.isArray(rawExtraDates)
      ? (rawExtraDates as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
  return {
    id: d.id,
    name: typeof data.name === "string" ? data.name : "",
    gradeLabel: gradeLabel(displayGrade(data.grade, data.gradeYear)),
    status: normalizeStudentStatus(data.status),
    billable: isBillableStudent(data),
    createdAtMillis,
    ...(opts?.hasCheckInPin !== undefined ? { hasCheckInPin: opts.hasCheckInPin } : {}),
    tuitionDueDayOfMonth,
    tuitionAmount: typeof data.tuitionAmount === "number" ? data.tuitionAmount : null,
    weeklySessionCount,
    pricePerSession,
    sessionBalance,
    extraSessionDates,
    hasPendingPaymentReminder:
      data.sentSessionPaymentReminder === true && !data.tuitionReminderConfirmedAt,
  };
}

/** 학부모 앱에 내려주는 반 정보 — 이름·수업 시간만(선생님·강의실·정원·반 id 없음) */
type ParentClassSlot = { weekday: number; start: string; end: string };
type ParentChildClass = { name: string; schedule: ParentClassSlot[] };

const CLASS_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function readParentClassSchedule(raw: unknown): ParentClassSlot[] {
  if (!Array.isArray(raw)) return [];
  const slots = raw.flatMap((x): ParentClassSlot[] => {
    const s = x as Record<string, unknown> | null;
    if (!s) return [];
    const { weekday, start, end } = s;
    if (
      typeof weekday !== "number" || !Number.isInteger(weekday) || weekday < 1 || weekday > 7 ||
      typeof start !== "string" || !CLASS_TIME_RE.test(start) ||
      typeof end !== "string" || !CLASS_TIME_RE.test(end) ||
      start >= end
    ) {
      return [];
    }
    return [{ weekday, start, end }];
  });
  return slots.sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

function studentClassIds(d: QueryDocumentSnapshot): string[] {
  const raw = d.get("classIds");
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0 && !x.includes("/"));
}

/**
 * 표시 자녀의 반(종강·없는 반 제외) — 반 문서는 한 번씩만 읽는다(반 id가 없으면 읽지 않음).
 * 반 순서는 반 관리의 `sortOrder` → 이름.
 */
async function loadParentChildClasses(
  db: admin.firestore.Firestore,
  academyId: string,
  docs: QueryDocumentSnapshot[],
): Promise<Map<string, ParentChildClass[]>> {
  const classIds = [...new Set(docs.flatMap(studentClassIds))];
  const byClassId = new Map<string, { name: string; sortOrder: number; schedule: ParentClassSlot[] }>();
  if (classIds.length) {
    const snaps = await db.getAll(...classIds.map((id) => db.doc(`academies/${academyId}/classes/${id}`)));
    for (const snap of snaps) {
      if (!snap.exists || snap.get("status") === "ended") continue;
      const name = typeof snap.get("name") === "string" ? (snap.get("name") as string).trim() : "";
      if (!name) continue;
      const order = snap.get("sortOrder");
      byClassId.set(snap.id, {
        name,
        sortOrder: typeof order === "number" && Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
        schedule: readParentClassSchedule(snap.get("schedule")),
      });
    }
  }
  const out = new Map<string, ParentChildClass[]>();
  for (const d of docs) {
    const list = studentClassIds(d)
      .flatMap((id) => {
        const c = byClassId.get(id);
        return c ? [c] : [];
      })
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ko"))
      .map((c) => ({ name: c.name, schedule: c.schedule }));
    out.set(d.id, list);
  }
  return out;
}

export const getParentActivationState = onCall(
  { cors: true },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
    }
    const { uid } = request.auth;

    const db = admin.firestore();
    const { parent } = await reconcileUserActivationMirror(db, uid, "reconcile");

    return {
      ok: true,
      anyActive: parent.anyActive,
      primaryStatus: parent.primaryStatus as ParentAccountStatus | null,
      primaryAcademyId: parent.primaryAcademyId,
    };
  },
);

/**
 * 활성 학부모의 자녀(학생) 목록 — `students` 컬렉션 list + 학부모 OR 분기 규칙이
 * 에뮬에서 evaluation error를 낼 수 있어 Admin 조회로 통일합니다.
 */
export const listParentChildrenStudents = onCall(
  { cors: true },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
    }
    const uid = request.auth.uid;
    const academyId =
      typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
    if (!academyId) {
      throw new HttpsError("invalid-argument", "학원 ID가 필요합니다.");
    }

    const db = admin.firestore();
    const parentRef = db.doc(`academies/${academyId}/parents/${uid}`);
    const col = db.collection(`academies/${academyId}/students`);

    const [parentSnap, snap, requireStudentCheckInPin] = await Promise.all([
      parentRef.get(),
      col.where("parentUids", "array-contains", uid).get(),
      getRequireStudentCheckInPin(db, academyId),
    ]);
    const accountStatus = parentSnap.get("status");
    if (!parentSnap.exists || (accountStatus !== "active" && accountStatus !== "pending_approval")) {
      throw new HttpsError(
        "permission-denied",
        "이 학원의 활성 학부모만 자녀 학생 목록을 조회할 수 있습니다.",
      );
    }
    // 승인 대기·연결 대기 — 빈 목록 + 상태(토큰 클레임이 예전 active로 남아 있어도 화면이 연결 대기로 바꾼다)
    if (accountStatus === "pending_approval") {
      return {
        ok: true as const,
        accountStatus: "pending_approval" as const,
        students: [],
        kiosk: { requireStudentCheckInPin },
      };
    }

    // 학부모 앱에는 재원·휴원 자녀만(미등록·퇴원은 연결은 유지하되 숨김)
    const visibleDocs = snap.docs.filter((d) => {
      const status = normalizeStudentStatus(d.get("status"));
      return status === "enrolled" || status === "on_leave";
    });
    const pinRefs = visibleDocs.map((d) => db.doc(studentCheckInSecretPath(academyId, d.id)));
    const [pinSnaps, invoiceSummaries, childClasses] = await Promise.all([
      pinRefs.length ? db.getAll(...pinRefs) : Promise.resolve([]),
      loadNextDueInvoiceSummaries(
        db,
        academyId,
        visibleDocs.filter((d) => isBillableStudent(d.data())).map((d) => ({ id: d.id, data: d.data() })),
      ),
      loadParentChildClasses(db, academyId, visibleDocs),
    ]);
    const students = visibleDocs.map((d, i) => {
      const pinSnap = pinSnaps[i];
      const hasCheckInPin =
        typeof pinSnap?.get("pinHash") === "string" && (pinSnap.get("pinHash") as string).length > 0;
      return {
        ...serializeStudentDocForCallable(d, { hasCheckInPin }),
        // 매월 지정일 납부 학생의 다음 납부 청구서(조정 반영 금액·납부 여부)
        tuitionInvoice: invoiceSummaries.get(d.id) ?? null,
        // 다니는 반(종강 제외) — 이름·수업 시간만
        classes: childClasses.get(d.id) ?? [],
      };
    });

    return {
      ok: true as const,
      accountStatus: "active" as const,
      students,
      kiosk: { requireStudentCheckInPin },
    };
  },
);

/** 재활성화 — 비활성 계정만, 상태는 지금 연결 수로(연결 0명이면 연결 대기) */
export const activateParent = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid: callerUid, token } = request.auth;
  const academyId = requireId(request.data?.academyId);
  const parentAuthUid = requireId(request.data?.parentAuthUid);

  const db = admin.firestore();
  await assertPermission(db, academyId, callerUid, token, "operations.parents");

  const ref = parentDocRef(db, academyId, parentAuthUid);
  const status = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError("not-found", "학부모 정보를 찾을 수 없습니다.");
    }
    if (snap.get("status") !== "inactive") {
      throw new HttpsError("failed-precondition", "비활성 상태의 계정만 다시 활성화할 수 있습니다.");
    }
    const linkedStudentIds = await readLinkedStudentIdsInTx(tx, db, academyId, parentAuthUid);
    const next = parentStatusFromLinks(linkedStudentIds.length);
    tx.update(ref, {
      status: next,
      linkedStudentIds,
      ...(next === "active" ? { activatedAt: FieldValue.serverTimestamp() } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return next;
  });

  await admin.auth().setCustomUserClaims(parentAuthUid, {
    role: "parent",
    academyId,
    membershipStatus: status,
  });
  await admin.auth().updateUser(parentAuthUid, { disabled: false });

  return { ok: true, membershipStatus: status };
});

/** 비활성화 — 사용 중·연결 대기 계정(Auth 끔). 연결은 그대로 두고 규칙·푸시 수신자에서 빠진다 */
export const deactivateParent = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const { uid: callerUid, token } = request.auth;
  const academyId = requireId(request.data?.academyId);
  const parentAuthUid = requireId(request.data?.parentAuthUid);

  const db = admin.firestore();
  await assertPermission(db, academyId, callerUid, token, "operations.parents");

  const ref = parentDocRef(db, academyId, parentAuthUid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError("not-found", "학부모 정보를 찾을 수 없습니다.");
    }
    const st = snap.get("status");
    if (st !== "active" && st !== "pending_approval") {
      throw new HttpsError("failed-precondition", "사용 중이거나 연결 대기 중인 계정만 비활성화할 수 있습니다.");
    }
    tx.update(ref, {
      status: "inactive" satisfies ParentAccountStatus,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  await admin.auth().setCustomUserClaims(parentAuthUid, {
    role: "parent",
    academyId,
    parentDisabled: true,
  });
  await admin.auth().updateUser(parentAuthUid, { disabled: true });

  return { ok: true };
});

/**
 * 가입 거절·계정 삭제 — 모든 상태. 원생은 그대로 두고 연결만 해제(결제 `parentUids`는 학생 트리거가 정리),
 * 번호 색인·로그인 정보·계정 문서 삭제. 다른 학원 멤버십·소유 학원이 없으면 Auth 계정까지 지운다.
 */
export const deleteParentAccount = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireId(request.data?.academyId);
  const parentUid = requireId(request.data?.parentUid);

  const db = admin.firestore();
  await assertPermission(db, academyId, request.auth.uid, request.auth.token, "operations.parents");

  const { authUid } = await deleteParentAccountData(db, academyId, parentUid);
  if (!(await authUidHasOtherMemberships(db, authUid))) {
    try {
      await admin.auth().deleteUser(authUid);
    } catch (e) {
      logger.warn("deleteParentAccount: auth delete skipped", { authUid, e });
    }
    await purgeUserFirestoreData(db, authUid);
  }
  return { ok: true };
});
