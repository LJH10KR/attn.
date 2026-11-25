import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { classAttendanceCol, classCancellationRef, parseVia, requireId } from "./attendance";
import { staffRefFor } from "./attendance-correct";
import { resolveAcademyActor } from "./lib/academy-access";
import { assertCorrectionActor, correctionActorFromTx, writeCorrectionTx } from "./lib/attendance-corrections";
import {
  CLASS_CANCELLATION_MEMO_MAX_LENGTH,
  classCancellationBlock,
  classCancellationBlockMessage,
  isValidDateString,
  seoulDateString,
  slotsOnWeekday,
  weekdayOfDate,
} from "./lib/attendance-rules";
import { isClassStatus } from "./lib/class-teachers";
import { readSchedule } from "./lib/class-schedule";

/**
 * 3-B 휴강 기록 — 결정 `docs/stage3-handoff/3-B-decisions.md` B7, 계획 `3-B-plan.md` ★11·★12·P1.
 * `academies/{id}/classCancellations/{date}_{classId}`(서버 전용 쓰기). 기록만 — 월정액 휴강 차감은 4단계.
 * - 권한 = 원장·`lessons.attendance`(트랜잭션 안에서 직원 문서로 다시 확인), 학부모 알림 없음(안내는 3-E 공지).
 * - 오늘 = 반 있음·종강 아님·그 요일 수업 있음·그날 그 반 출결 0건, 지난 날짜 = 반 있음 + 출결 0건만(P1, 3-A A4).
 * - 휴강 취소는 문서만 있으면(그 뒤 지워진 반 포함). 메모만 바꾸기 허용. 정정 이력 layer "class_cancel".
 * - 반 출결 기록·정정 함수도 트랜잭션 안에서 휴강 문서를 읽고 거부한다(★12) — 이 함수는 그 반 출결을 조회하므로 서로 순서가 맞춰진다.
 */

/** 출결관리 반 머리·반 관리 목록 카드(3-B 후속 Q2 — 오늘 휴강) */
const CANCELLATION_VIA = ["attendance_screen", "class_list"] as const;
const PERMISSION_MESSAGE = "휴강은 원장이나 출결 권한이 있는 직원만 기록할 수 있습니다.";

export const setClassCancellation = onCall(async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const data = (request.data ?? {}) as Record<string, unknown>;
  const academyId = requireId(data.academyId);
  const classId = requireId(data.classId);
  if (!isValidDateString(data.date) || typeof data.cancelled !== "boolean") {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }
  const date = data.date;
  const cancelled = data.cancelled;
  let memo: string | null | undefined;
  if (data.memo !== undefined && data.memo !== null) {
    if (typeof data.memo !== "string") throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
    memo = data.memo.trim().slice(0, CLASS_CANCELLATION_MEMO_MAX_LENGTH) || null;
  }
  const via = parseVia(data.via, CANCELLATION_VIA, "attendance_screen");
  const today = seoulDateString();

  const db = admin.firestore();
  const actor = assertCorrectionActor(await resolveAcademyActor(db, academyId, request.auth.uid), PERMISSION_MESSAGE);
  const classRef = db.doc(`academies/${academyId}/classes/${classId}`);
  const ref = classCancellationRef(db, academyId, date, classId);
  const recordsQuery = classAttendanceCol(db, academyId).where("classId", "==", classId).where("date", "==", date);
  const staffRef = staffRefFor(db, academyId, actor);

  return db.runTransaction(async (tx) => {
    const [clsSnap, snap, staffSnap] = await tx.getAll(classRef, ref, ...(staffRef ? [staffRef] : []));
    const by = correctionActorFromTx(actor, staffSnap ?? null, PERMISSION_MESSAGE);
    const prevMemo = snap!.exists && typeof snap!.get("memo") === "string" && snap!.get("memo") ? (snap!.get("memo") as string) : null;
    const currentName = clsSnap!.exists ? clsSnap!.get("name") : null;
    const className =
      typeof currentName === "string" && currentName
        ? currentName
        : snap!.exists && typeof snap!.get("className") === "string"
          ? (snap!.get("className") as string)
          : "반";
    const entry = { academyId, date, studentId: "", studentName: "", classId, className, via, by };

    if (!cancelled) {
      if (!snap!.exists) return { ok: true as const, changed: false, cancelled: false };
      tx.delete(ref);
      writeCorrectionTx(tx, db, { ...entry, layer: "class_cancel", action: "delete", before: { memo: prevMemo }, after: null });
      return { ok: true as const, changed: true, cancelled: false };
    }

    if (snap!.exists) {
      // 이미 휴강 — 메모만 바꾸기(메모를 보내지 않으면 그대로)
      if (memo === undefined || memo === prevMemo) return { ok: true as const, changed: false, cancelled: true };
      tx.update(ref, { memo: memo ?? FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
      writeCorrectionTx(tx, db, {
        ...entry, layer: "class_cancel", action: "detail", before: { memo: prevMemo }, after: { memo: memo ?? null },
      });
      return { ok: true as const, changed: true, cancelled: true };
    }

    const cls = clsSnap!.exists ? (clsSnap!.data() as Record<string, unknown>) : null;
    const slots = cls ? slotsOnWeekday(readSchedule(cls.schedule), weekdayOfDate(date)) : [];
    const recordCount = (await tx.get(recordsQuery)).size;
    const block = classCancellationBlock({
      date,
      today,
      classExists: cls !== null,
      classEnded: cls !== null && isClassStatus(cls.status) && cls.status === "ended",
      hasLesson: slots.length > 0,
      recordCount,
    });
    if (block === "class_missing") throw new HttpsError("not-found", "반을 찾을 수 없습니다.");
    if (block) {
      throw new HttpsError("failed-precondition", classCancellationBlockMessage(block, { date, className, recordCount }));
    }
    tx.create(ref, {
      academyId,
      date,
      classId,
      className,
      slots: slots.map((s) => ({ start: s.start, end: s.end })),
      ...(memo ? { memo } : {}),
      createdByUid: actor.uid,
      byRole: by.byRole,
      byName: by.byName,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    writeCorrectionTx(tx, db, {
      ...entry, layer: "class_cancel", action: "create", before: null, after: { memo: memo ?? null },
    });
    return { ok: true as const, changed: true, cancelled: true };
  });
});
