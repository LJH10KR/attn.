import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import {
  applyMulticastDeliveryResults,
  type PushTokenBucket,
} from "./push-subscription-delivery";

const REGION = "asia-northeast3";

type TuitionSettings = {
  kakaoPayLink?: string;
  bankName?: string;
  accountNumber?: string;
  accountHolder?: string;
};

function buildTokenBuckets(
  subsSnap: FirebaseFirestore.QuerySnapshot,
): PushTokenBucket[] {
  const buckets: PushTokenBucket[] = [];
  const indexByToken = new Map<string, number>();

  for (const d of subsSnap.docs) {
    const t = d.get("token");
    if (typeof t !== "string" || t.length <= 20) continue;

    const updatedAt = d.get("updatedAt") as Timestamp | undefined;
    const millis = updatedAt?.toMillis() ?? 0;
    const invalidDeliveryCount =
      typeof d.get("invalidDeliveryCount") === "number"
        ? (d.get("invalidDeliveryCount") as number)
        : 0;

    const existing = indexByToken.get(t);
    if (existing !== undefined) {
      buckets[existing]!.refs.push(d.ref);
      buckets[existing]!.invalidCounts.push(invalidDeliveryCount);
      buckets[existing]!.updatedAtMillis = Math.max(
        buckets[existing]!.updatedAtMillis,
        millis,
      );
    } else {
      indexByToken.set(t, buckets.length);
      buckets.push({
        token: t,
        refs: [d.ref],
        updatedAtMillis: millis,
        invalidCounts: [invalidDeliveryCount],
      });
    }
  }

  return buckets;
}

async function sendSessionPaymentReminderToParent(
  db: admin.firestore.Firestore,
  params: {
    academyId: string;
    studentId: string;
    studentName: string;
    parentUserId: string;
    sessionBalance: number;
    weeklySessionCount: number;
    pricePerSession: number | undefined;
    extraSessionDates: string[];
    settings: TuitionSettings;
  },
): Promise<void> {
  const {
    academyId,
    studentId,
    studentName,
    parentUserId,
    sessionBalance,
    weeklySessionCount,
    pricePerSession,
    extraSessionDates,
    settings,
  } = params;

  const parentUserRef = db.doc(`users/${parentUserId}`);
  const userSnap = await parentUserRef.get();

  if (!userSnap.exists || userSnap.get("pushNotificationsEnabled") !== true) {
    logger.info("sessionPaymentReminder: parent push disabled, skipping", {
      studentId,
      parentUserId,
    });
    return;
  }

  const userData = userSnap.data();
  const userLastSyncedAt =
    (userData?.pushLastSyncServerAt as Timestamp | undefined) ??
    (userData?.pushSubscriptionLastSyncedAt as Timestamp | undefined);

  const subsSnap = await parentUserRef.collection("pushSubscriptions").get();
  const buckets = buildTokenBuckets(subsSnap);
  const tokens = buckets.map((b) => b.token);

  if (tokens.length === 0) {
    logger.info("sessionPaymentReminder: no FCM tokens, skipping", {
      studentId,
      parentUserId,
    });
    return;
  }

  // 납부 안내 메시지 구성 (월 4주 단위 정산)
  const extraCount = extraSessionDates.length;
  const monthlySessionCount = weeklySessionCount * 4;
  let body: string;
  if (sessionBalance <= 0) {
    body = `${studentName} 학생의 수업 잔여 횟수가 없습니다`;
    if (extraCount > 0) body += ` (초과 ${extraCount}회 발생)`;
    body += `. 다음 4주 수업(${monthlySessionCount}회)을 위해 납부를 부탁드립니다.`;
  } else {
    body = `${studentName} 학생의 잔여 수업이 ${sessionBalance}회 남았습니다`;
    if (extraCount > 0) body += ` (초과 ${extraCount}회 포함)`;
    body += `. 다음 4주 수업(${monthlySessionCount}회)을 위해 납부를 부탁드립니다.`;
  }

  // 권장 납부 금액: 다음 4주 수업료(월 단위) + 초과 수업 부채
  const debtSessions = Math.max(0, -sessionBalance);
  const totalSessions = monthlySessionCount + debtSessions;
  const suggestedAmount =
    pricePerSession !== undefined ? totalSessions * pricePerSession : undefined;

  const dataPayload: Record<string, string> = {
    title: "attn.",
    body,
    type: "session_payment_reminder",
    studentId,
    studentName,
    academyId,
    parentUserId,
    sessionBalance: String(sessionBalance),
    weeklySessionCount: String(weeklySessionCount),
  };

  if (suggestedAmount !== undefined) {
    dataPayload.suggestedAmount = String(suggestedAmount);
  }
  if (pricePerSession !== undefined) {
    dataPayload.pricePerSession = String(pricePerSession);
  }
  if (extraSessionDates.length > 0) {
    dataPayload.extraSessionDates = extraSessionDates.join(",");
  }
  if (settings.kakaoPayLink) dataPayload.kakaoPayLink = settings.kakaoPayLink;
  if (settings.bankName) dataPayload.bankName = settings.bankName;
  if (settings.accountNumber) dataPayload.accountNumber = settings.accountNumber;
  if (settings.accountHolder) dataPayload.accountHolder = settings.accountHolder;

  const resp = await admin
    .messaging()
    .sendEachForMulticast({ tokens, data: dataPayload });

  if (resp.failureCount > 0) {
    logger.warn("sessionPaymentReminder: FCM partial failure", {
      studentId,
      parentUserId,
      successCount: resp.successCount,
      failureCount: resp.failureCount,
    });
  }

  await applyMulticastDeliveryResults({
    db,
    parentUserId,
    userLastSyncedAt,
    buckets,
    responses: resp.responses,
    logContext: "sendSessionPaymentReminder",
  });

  if (resp.successCount > 0) {
    await db
      .doc(`academies/${academyId}/students/${studentId}`)
      .update({ sentSessionPaymentReminder: true });

    logger.info("sessionPaymentReminder: sent successfully", {
      studentId,
      parentUserId,
      sessionBalance,
      weeklySessionCount,
      successCount: resp.successCount,
    });
  }
}

/**
 * 학생 문서 업데이트 시 sessionBalance 감소 → 기준치 이하 도달 시 즉시 FCM 발송.
 * 스케줄러(오전 9시)는 이 트리거가 놓친 케이스에 대한 안전망으로 유지.
 */
export const onStudentSessionBalanceChanged = onDocumentUpdated(
  {
    document: "academies/{academyId}/students/{studentId}",
    region: REGION,
    memory: "256MiB",
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;

    const weeklySessionCount =
      typeof after.weeklySessionCount === "number" &&
      Number.isInteger(after.weeklySessionCount) &&
      after.weeklySessionCount >= 1
        ? (after.weeklySessionCount as number)
        : null;
    if (!weeklySessionCount) return;

    const balanceBefore =
      typeof before.sessionBalance === "number" && Number.isInteger(before.sessionBalance)
        ? (before.sessionBalance as number)
        : 0;
    const balanceAfter =
      typeof after.sessionBalance === "number" && Number.isInteger(after.sessionBalance)
        ? (after.sessionBalance as number)
        : 0;

    // sessionBalance가 감소한 경우에만 처리
    if (balanceAfter >= balanceBefore) return;

    // 아직 기준치(주당 횟수) 초과 — 알림 불필요
    if (balanceAfter > weeklySessionCount) return;

    // 이미 발송된 알림 — 충전 시 초기화됨
    if (after.sentSessionPaymentReminder === true) return;

    const { academyId, studentId } = event.params;
    const parentUserId = typeof after.parentUserId === "string" ? after.parentUserId : "";
    if (!parentUserId) return;

    const studentName = typeof after.name === "string" && after.name ? after.name : "학생";
    const pricePerSession =
      typeof after.pricePerSession === "number" && after.pricePerSession >= 0
        ? (after.pricePerSession as number)
        : undefined;
    const extraSessionDates = Array.isArray(after.extraSessionDates)
      ? (after.extraSessionDates as string[]).filter((d) => typeof d === "string")
      : [];

    const db = admin.firestore();
    let settings: TuitionSettings = {};
    try {
      const settingsSnap = await db.doc(`academies/${academyId}/meta/tuitionSettings`).get();
      if (settingsSnap.exists) settings = settingsSnap.data() as TuitionSettings;
    } catch (e) {
      logger.error("onStudentSessionBalanceChanged: tuitionSettings load failed", { academyId, e });
    }

    try {
      await sendSessionPaymentReminderToParent(db, {
        academyId,
        studentId,
        studentName,
        parentUserId,
        sessionBalance: balanceAfter,
        weeklySessionCount,
        pricePerSession,
        extraSessionDates,
        settings,
      });
    } catch (e) {
      logger.error("onStudentSessionBalanceChanged: send failed", { academyId, studentId, e });
    }
  },
);

/**
 * 매일 서울 기준 오전 9시에 실행되는 회차 방식 원비 납부 안내 스케줄러.
 *
 * 처리 흐름:
 * 1. 모든 academies 순회
 * 2. weeklySessionCount >= 1 인 students 조회
 * 3. sessionBalance <= weeklySessionCount 이고 sentSessionPaymentReminder가 미설정인 경우 FCM 발송
 * 4. 발송 후 sentSessionPaymentReminder: true 마킹 (충전 시 초기화)
 */
export const sendSessionPaymentReminders = onSchedule(
  {
    schedule: "0 9 * * *",
    timeZone: "Asia/Seoul",
    region: REGION,
    memory: "256MiB",
    timeoutSeconds: 540,
  },
  async () => {
    const db = admin.firestore();
    const now = new Date();
    const todaySeoul = now.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });

    const academiesSnap = await db.collection("academies").get();
    logger.info("sessionPaymentReminder: start", {
      todaySeoul,
      academyCount: academiesSnap.size,
    });

    for (const academyDoc of academiesSnap.docs) {
      const academyId = academyDoc.id;

      let settings: TuitionSettings = {};
      try {
        const settingsSnap = await db
          .doc(`academies/${academyId}/meta/tuitionSettings`)
          .get();
        if (settingsSnap.exists) {
          settings = settingsSnap.data() as TuitionSettings;
        }
      } catch (e) {
        logger.error("sessionPaymentReminder: tuitionSettings load failed", {
          academyId,
          e,
        });
      }

      let studentsSnap: FirebaseFirestore.QuerySnapshot;
      try {
        studentsSnap = await db
          .collection(`academies/${academyId}/students`)
          .where("weeklySessionCount", ">=", 1)
          .get();
      } catch (e) {
        logger.error("sessionPaymentReminder: students query failed", {
          academyId,
          e,
        });
        continue;
      }

      for (const studentDoc of studentsSnap.docs) {
        const studentId = studentDoc.id;
        const data = studentDoc.data();

        const weeklySessionCount =
          typeof data.weeklySessionCount === "number" &&
          Number.isInteger(data.weeklySessionCount) &&
          data.weeklySessionCount >= 1
            ? data.weeklySessionCount
            : null;
        if (!weeklySessionCount) continue;

        // sessionBalance가 null이면 0으로 취급
        const sessionBalance =
          typeof data.sessionBalance === "number" && Number.isInteger(data.sessionBalance)
            ? data.sessionBalance
            : 0;

        // 잔여 횟수가 주당 횟수 이하일 때만 알림
        if (sessionBalance > weeklySessionCount) continue;

        // 이미 발송된 경우 건너뜀 (충전 시 초기화)
        if (data.sentSessionPaymentReminder === true) {
          logger.info("sessionPaymentReminder: already sent, skipping", { studentId });
          continue;
        }

        const parentUserId =
          typeof data.parentUserId === "string" ? data.parentUserId : "";
        if (!parentUserId) continue;

        const studentName =
          typeof data.name === "string" && data.name ? data.name : "학생";

        const pricePerSession =
          typeof data.pricePerSession === "number" && data.pricePerSession >= 0
            ? data.pricePerSession
            : undefined;

        const extraSessionDates =
          Array.isArray(data.extraSessionDates)
            ? (data.extraSessionDates as string[]).filter((d) => typeof d === "string")
            : [];

        try {
          await sendSessionPaymentReminderToParent(db, {
            academyId,
            studentId,
            studentName,
            parentUserId,
            sessionBalance,
            weeklySessionCount,
            pricePerSession,
            extraSessionDates,
            settings,
          });
        } catch (e) {
          logger.error("sessionPaymentReminder: student processing failed", {
            academyId,
            studentId,
            e,
          });
        }
      }
    }

    logger.info("sessionPaymentReminder: done", { todaySeoul });
  },
);
