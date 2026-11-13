import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import type { AttendanceNotifyOutcome } from "./attendance-send-core";
import { recordArrivalCore, recordClassCore, requireId } from "./attendance";
import { correctArrivalCore, correctClassCore } from "./attendance-correct";
import { resolveAcademyActor, type AcademyActor } from "./lib/academy-access";
import { assertCorrectionActor } from "./lib/attendance-corrections";
import {
  ATTENDANCE_BATCH_MAX,
  BATCH_MODE_MISMATCH_MESSAGE,
  CORRECTION_DATE_MESSAGES,
  isValidDateString,
  seoulDateString,
} from "./lib/attendance-rules";

/**
 * 3-A 일괄 처리(A8·★6) — 원장 출결 화면 반 명단에서 여러 원생을 골라 등원·반 출석·반 결석.
 * - 원장·`lessons.attendance`만(/teacher에는 일괄이 없음), 최대 50명, 원생마다 차례로(트랜잭션은 원생마다).
 * - 오늘 = 기존 기록 함수 로직(조건·알림·하루 10회 그대로), 지난 날짜 = 정정 로직(알림 없음·정정 이력).
 * - B1: 화면이 기대한 `mode`(today/past)와 서버 판정이 다르면 전체 거부(알림이 갈 줄 알았는데 안 가는 일 방지).
 * - 막힌 줄은 건너뛰고 서버 문구를 줄 결과에 담는다.
 */

const BATCH_ACTIONS = ["arrive", "class_present", "class_absent"] as const;
type BatchAction = (typeof BATCH_ACTIONS)[number];
type BatchMode = "today" | "past";

export type BatchRowResult = {
  studentId: string;
  result: "changed" | "unchanged" | "blocked";
  message?: string;
  notification?: AttendanceNotifyOutcome | null;
};

const ROW_ERROR_CODES = new Set(["failed-precondition", "not-found", "permission-denied", "invalid-argument"]);
const ROW_FALLBACK_MESSAGE = "처리하지 못했습니다. 다시 시도해 주세요.";

function parseStudentIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ATTENDANCE_BATCH_MAX) {
    throw new HttpsError(
      "invalid-argument",
      `일괄 처리는 한 번에 1~${ATTENDANCE_BATCH_MAX}명까지 할 수 있습니다.`,
    );
  }
  const ids = raw.map(requireId);
  if (new Set(ids).size !== ids.length) throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  return ids;
}

async function runRow(
  db: admin.firestore.Firestore,
  ctx: { actor: AcademyActor; academyId: string; classId: string; date: string; mode: BatchMode; action: BatchAction },
  studentId: string,
): Promise<BatchRowResult> {
  const { actor, academyId, classId, date, mode, action } = ctx;
  try {
    if (mode === "today") {
      const out =
        action === "arrive"
          ? await recordArrivalCore(db, {
            academyId, studentId, status: "present", via: "attendance_batch", callerUid: actor.uid, date,
          })
          : await recordClassCore(db, {
            actor, academyId, classId, studentId,
            status: action === "class_present" ? "present" : "absent",
            via: "attendance_batch", date,
          });
      return { studentId, result: out.changed ? "changed" : "unchanged", notification: out.notification };
    }
    const out =
      action === "arrive"
        ? await correctArrivalCore(db, {
          actor, academyId, studentId, date, status: "present", via: "attendance_batch",
        })
        : await correctClassCore(db, {
          actor, academyId, classId, studentId, date,
          status: action === "class_present" ? "present" : "absent",
          via: "attendance_batch",
        });
    return { studentId, result: out.changed ? "changed" : "unchanged" };
  } catch (e) {
    if (e instanceof HttpsError && ROW_ERROR_CODES.has(e.code)) {
      return { studentId, result: "blocked", message: e.message };
    }
    logger.error("recordAttendanceBatch row failed", { academyId, studentId, action, e });
    return { studentId, result: "blocked", message: ROW_FALLBACK_MESSAGE };
  }
}

/** 원장·출결 권한 — 반 명단 일괄 등원·출석·결석(줄마다 결과) */
export const recordAttendanceBatch = onCall({ timeoutSeconds: 120 }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const data = (request.data ?? {}) as Record<string, unknown>;
  const academyId = requireId(data.academyId);
  const classId = requireId(data.classId);
  const action = (BATCH_ACTIONS as readonly unknown[]).includes(data.action) ? (data.action as BatchAction) : null;
  const expected = data.mode === "today" || data.mode === "past" ? (data.mode as BatchMode) : null;
  if (!action || !expected || !isValidDateString(data.date)) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }
  const date = data.date;
  const studentIds = parseStudentIds(data.studentIds);

  const today = seoulDateString();
  if (date > today) throw new HttpsError("failed-precondition", CORRECTION_DATE_MESSAGES.future);
  const mode: BatchMode = date === today ? "today" : "past";
  if (mode !== expected) throw new HttpsError("failed-precondition", BATCH_MODE_MISMATCH_MESSAGE);

  const db = admin.firestore();
  const actor = assertCorrectionActor(
    await resolveAcademyActor(db, academyId, request.auth.uid),
    "일괄 처리는 원장이나 출결 권한이 있는 직원만 할 수 있습니다.",
  );

  const results: BatchRowResult[] = [];
  for (const studentId of studentIds) {
    results.push(await runRow(db, { actor, academyId, classId, date, mode, action }, studentId));
  }
  const counts = {
    changed: results.filter((r) => r.result === "changed").length,
    unchanged: results.filter((r) => r.result === "unchanged").length,
    blocked: results.filter((r) => r.result === "blocked").length,
  };
  return { ok: true as const, mode, results, counts };
});
