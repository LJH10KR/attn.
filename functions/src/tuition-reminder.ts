import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import {
  applyMulticastDeliveryResults,
  type PushTokenBucket,
} from "./push-subscription-delivery";

const REGION = "asia-northeast3";
const DAY_MS = 24 * 60 * 60 * 1000;

type TuitionSettings = {
  kakaoPayLink?: string;
  bankName?: string;
  accountNumber?: string;
  accountHolder?: string;
};

/**
 * 주어진 Date를 서울 시간 기준 당일 자정(00:00 KST)의 Unix ms로 변환합니다.
 * 날짜 비교 시 시:분:초를 제거하고 "서울 날짜" 단위로 맞추기 위해 사용합니다.
 */
function seoulMidnightMs(date: Date): number {
  const dateStr = date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  return new Date(`${dateStr}T00:00:00+09:00`).getTime();
}

/** 서울 기준 YYYY-MM-DD 문자열 */
function seoulDateString(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/**
 * attendance-push-delivery.ts의 loadPushBuckets와 동일한 패턴.
 * users/{uid}/pushSubscriptions 스냅샷에서 PushTokenBucket 배열을 빌드합니다.
 */
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

/**
 * 단일 학생에 대한 원비 납부 FCM 알림 전송.
 * - 학부모 push 수신 동의 여부를 먼저 확인합니다.
 * - FCM 전송 후 applyMulticastDeliveryResults로 토큰 상태를 갱신합니다.
 * - 전송 성공 시에만 sentTuitionReminders에 reminderKey를 기록합니다.
 * - tuitionSettings의 빈 문자열 필드는 data payload에서 생략합니다.
 */
async function sendReminderToParent(
  db: admin.firestore.Firestore,
  params: {
    academyId: string;
    studentId: string;
    studentName: string;
    parentUserId: string;
    tuitionAmount: number | undefined;
    dueDateLabel: string;
    reminderKey: string;
    diffDays: 7 | 1;
    settings: TuitionSettings;
  },
): Promise<void> {
  const {
    academyId,
    studentId,
    studentName,
    parentUserId,
    tuitionAmount,
    dueDateLabel,
    reminderKey,
    diffDays,
    settings,
  } = params;

  const parentUserRef = db.doc(`users/${parentUserId}`);
  const userSnap = await parentUserRef.get();

  if (!userSnap.exists || userSnap.get("pushNotificationsEnabled") !== true) {
    logger.info("tuitionReminder: parent push disabled, skipping", {
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
    logger.info("tuitionReminder: no FCM tokens, skipping", {
      studentId,
      parentUserId,
    });
    return;
  }

  const body =
    diffDays === 7
      ? `${studentName} 학생의 원비 납부일이 7일 남았습니다. (${dueDateLabel})`
      : `${studentName} 학생의 원비 납부일이 내일입니다. (${dueDateLabel})`;

  // 빈 문자열 또는 미설정 필드는 payload에서 생략합니다.
  const dataPayload: Record<string, string> = {
    title: "attn.",
    body,
    type: "tuition_reminder",
    diffDays: String(diffDays),
    studentId,
    studentName,
    academyId,
    parentUserId,
  };

  if (tuitionAmount !== undefined) {
    dataPayload.tuitionAmount = String(tuitionAmount);
  }
  if (settings.kakaoPayLink) dataPayload.kakaoPayLink = settings.kakaoPayLink;
  if (settings.bankName) dataPayload.bankName = settings.bankName;
  if (settings.accountNumber) dataPayload.accountNumber = settings.accountNumber;
  if (settings.accountHolder) dataPayload.accountHolder = settings.accountHolder;

  const resp = await admin
    .messaging()
    .sendEachForMulticast({ tokens, data: dataPayload });

  if (resp.failureCount > 0) {
    logger.warn("tuitionReminder: FCM partial failure", {
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
    logContext: "sendTuitionReminder",
  });

  if (resp.successCount > 0) {
    await db
      .doc(`academies/${academyId}/students/${studentId}`)
      .update({ sentTuitionReminders: FieldValue.arrayUnion(reminderKey) });

    logger.info("tuitionReminder: sent successfully", {
      studentId,
      parentUserId,
      reminderKey,
      successCount: resp.successCount,
    });
  }
}

/**
 * 매일 서울 기준 오전 9시에 실행되는 원비 납부 알림 스케줄러.
 *
 * 처리 흐름:
 * 1. 모든 academies 순회
 * 2. 각 academy의 tuitionSettings 조회 (카카오페이 링크, 계좌 정보)
 * 3. tuitionDueDate가 설정된 students 조회
 * 4. 서울 날짜 기준 D-7 / D-1 해당 학생에게 FCM 알림 발송
 * 5. sentTuitionReminders로 중복 발송 방지
 */
export const sendTuitionReminders = onSchedule(
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
    const todayMidnightMs = seoulMidnightMs(now);
    const todaySeoul = seoulDateString(now);

    const academiesSnap = await db.collection("academies").get();
    logger.info("tuitionReminder: start", {
      todaySeoul,
      academyCount: academiesSnap.size,
    });

    for (const academyDoc of academiesSnap.docs) {
      const academyId = academyDoc.id;

      // tuitionSettings 조회 — 실패해도 계속 진행 (설정 없이 알림 발송)
      let settings: TuitionSettings = {};
      try {
        const settingsSnap = await db
          .doc(`academies/${academyId}/meta/tuitionSettings`)
          .get();
        if (settingsSnap.exists) {
          settings = settingsSnap.data() as TuitionSettings;
        }
      } catch (e) {
        logger.error("tuitionReminder: tuitionSettings load failed", {
          academyId,
          e,
        });
      }

      // tuitionDueDate가 설정된 학생 조회
      let studentsSnap: FirebaseFirestore.QuerySnapshot;
      try {
        studentsSnap = await db
          .collection(`academies/${academyId}/students`)
          .where("tuitionDueDate", "!=", null)
          .get();
      } catch (e) {
        logger.error("tuitionReminder: students query failed", {
          academyId,
          e,
        });
        continue;
      }

      for (const studentDoc of studentsSnap.docs) {
        const studentId = studentDoc.id;
        const data = studentDoc.data();

        const tuitionDueDate = data.tuitionDueDate as Timestamp | undefined;
        if (!tuitionDueDate) continue;

        // 서울 자정 기준으로 정규화한 뒤 D-day 차이를 계산합니다.
        const dueMidnightMs = seoulMidnightMs(
          new Date(tuitionDueDate.toMillis()),
        );
        const diffDays = Math.round(
          (dueMidnightMs - todayMidnightMs) / DAY_MS,
        );

        if (diffDays !== 7 && diffDays !== 1) continue;

        const parentUserId =
          typeof data.parentUserId === "string" ? data.parentUserId : "";
        if (!parentUserId) continue;

        const dueDateKey = seoulDateString(new Date(tuitionDueDate.toMillis()));
        const reminderKey = `${dueDateKey}_D${diffDays}`;

        // 중복 발송 방지
        const sentReminders = Array.isArray(data.sentTuitionReminders)
          ? (data.sentTuitionReminders as string[])
          : [];
        if (sentReminders.includes(reminderKey)) {
          logger.info("tuitionReminder: already sent, skipping", {
            studentId,
            reminderKey,
          });
          continue;
        }

        const studentName =
          typeof data.name === "string" && data.name ? data.name : "학생";
        const tuitionAmount =
          typeof data.tuitionAmount === "number"
            ? data.tuitionAmount
            : undefined;

        const dueDateLabel = new Date(
          tuitionDueDate.toMillis(),
        ).toLocaleDateString("ko-KR", {
          timeZone: "Asia/Seoul",
          year: "numeric",
          month: "long",
          day: "numeric",
        });

        try {
          await sendReminderToParent(db, {
            academyId,
            studentId,
            studentName,
            parentUserId,
            tuitionAmount,
            dueDateLabel,
            reminderKey,
            diffDays: diffDays as 7 | 1,
            settings,
          });
        } catch (e) {
          logger.error("tuitionReminder: student processing failed", {
            academyId,
            studentId,
            reminderKey,
            e,
          });
          // 해당 학생 실패 시 에러 로깅 후 다음 학생 처리 계속
        }
      }
    }

    logger.info("tuitionReminder: done", { todaySeoul });
  },
);
