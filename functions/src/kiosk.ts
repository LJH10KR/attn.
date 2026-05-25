import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { assertFourDigitPin, hashPin, verifyPin } from "./pin-utils";
import { sendStudentAttendanceNotificationCore } from "./attendance-send-core";

const KIOSK_SETTINGS_DOC_ID = "kioskSettings";
const MAX_PIN_ATTEMPTS = 5;

function kioskSettingsRef(db: admin.firestore.Firestore, academyId: string) {
  return db.doc(`academies/${academyId}/meta/${KIOSK_SETTINGS_DOC_ID}`);
}

function studentCheckInSecretRef(
  db: admin.firestore.Firestore,
  academyId: string,
  studentId: string,
) {
  return db.doc(
    `academies/${academyId}/students/${studentId}/serverSecrets/checkIn`,
  );
}

async function assertCanManageAcademy(
  db: admin.firestore.Firestore,
  academyId: string,
  uid: string,
  token: admin.auth.DecodedIdToken,
): Promise<void> {
  const academySnap = await db.doc(`academies/${academyId}`).get();
  if (!academySnap.exists) {
    throw new HttpsError("not-found", "학원을 찾을 수 없습니다.");
  }
  const ownerUid = academySnap.get("ownerUid");
  if (typeof ownerUid === "string" && ownerUid === uid) {
    return;
  }
  if (token.role === "academy" && token.academyId === academyId) {
    return;
  }
  throw new HttpsError("permission-denied", "학원을 관리할 권한이 없습니다.");
}

async function assertAcademyKioskSession(
  db: admin.firestore.Firestore,
  academyId: string,
  uid: string,
  token: admin.auth.DecodedIdToken,
): Promise<void> {
  if (token.role === "academy" && token.academyId === academyId) {
    return;
  }
  const academySnap = await db.doc(`academies/${academyId}`).get();
  if (academySnap.exists && academySnap.get("ownerUid") === uid) {
    return;
  }
  throw new HttpsError("permission-denied", "출석 키오스크를 사용할 권한이 없습니다.");
}

type KioskSettingsPublic = {
  requireStudentCheckInPin: boolean;
  exitPinConfigured: boolean;
  exitPinLocked: boolean;
};

async function loadKioskSettingsPublic(
  db: admin.firestore.Firestore,
  academyId: string,
): Promise<KioskSettingsPublic> {
  const snap = await kioskSettingsRef(db, academyId).get();
  if (!snap.exists) {
    return {
      requireStudentCheckInPin: false,
      exitPinConfigured: false,
      exitPinLocked: false,
    };
  }
  const exitPinHash = snap.get("exitPinHash");
  const lockedAt = snap.get("exitPinLockedAt");
  return {
    requireStudentCheckInPin: snap.get("requireStudentCheckInPin") === true,
    exitPinConfigured: typeof exitPinHash === "string" && exitPinHash.length > 0,
    exitPinLocked: lockedAt instanceof Timestamp || lockedAt != null,
  };
}

export async function getRequireStudentCheckInPin(
  db: admin.firestore.Firestore,
  academyId: string,
): Promise<boolean> {
  const s = await loadKioskSettingsPublic(db, academyId);
  return s.requireStudentCheckInPin;
}

export const getAcademyKioskSettings = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  if (!academyId) {
    throw new HttpsError("invalid-argument", "학원 ID가 필요합니다.");
  }
  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, request.auth.uid, request.auth.token);
  const settings = await loadKioskSettingsPublic(db, academyId);
  return { ok: true as const, settings };
});

export const updateAcademyKioskSettings = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  if (!academyId) {
    throw new HttpsError("invalid-argument", "학원 ID가 필요합니다.");
  }
  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, request.auth.uid, request.auth.token);

  const ref = kioskSettingsRef(db, academyId);
  const snap = await ref.get();
  const patch: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (typeof request.data?.requireStudentCheckInPin === "boolean") {
    patch.requireStudentCheckInPin = request.data.requireStudentCheckInPin;
  }

  if (request.data?.unlockExitPinLock === true) {
    patch.exitPinFailedAttempts = 0;
    patch.exitPinLockedAt = null;
  }

  const newExitPinRaw = request.data?.newExitPin;
  if (newExitPinRaw !== undefined && newExitPinRaw !== null) {
    const newExitPin = assertFourDigitPin(newExitPinRaw, "키오스크 종료 PIN");
    const currentHash = snap.exists ? (snap.get("exitPinHash") as string | undefined) : undefined;
    if (currentHash) {
      const currentPin = request.data?.currentExitPin;
      if (currentPin === undefined || currentPin === null) {
        throw new HttpsError(
          "invalid-argument",
          "기존 키오스크 종료 PIN을 입력해 주세요.",
        );
      }
      const cur = assertFourDigitPin(currentPin, "기존 키오스크 종료 PIN");
      if (!verifyPin(cur, currentHash)) {
        throw new HttpsError("permission-denied", "기존 키오스크 종료 PIN이 올바르지 않습니다.");
      }
    }
    patch.exitPinHash = hashPin(newExitPin);
    patch.exitPinFailedAttempts = 0;
    patch.exitPinLockedAt = null;
  }

  if (Object.keys(patch).length <= 1) {
    throw new HttpsError("invalid-argument", "변경할 설정이 없습니다.");
  }

  await ref.set(patch, { merge: true });
  const settings = await loadKioskSettingsPublic(db, academyId);
  return { ok: true as const, settings };
});

export const verifyKioskExitPin = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  if (!academyId) {
    throw new HttpsError("invalid-argument", "학원 ID가 필요합니다.");
  }
  const pin = assertFourDigitPin(request.data?.pin, "키오스크 종료 PIN");
  const db = admin.firestore();
  await assertAcademyKioskSession(db, academyId, request.auth.uid, request.auth.token);

  const ref = kioskSettingsRef(db, academyId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("failed-precondition", "키오스크 종료 PIN이 설정되지 않았습니다.");
  }
  if (snap.get("exitPinLockedAt")) {
    throw new HttpsError(
      "resource-exhausted",
      "키오스크 종료 PIN이 잠겼습니다. 학원 설정에서 해제해 주세요.",
    );
  }
  const hash = snap.get("exitPinHash") as string | undefined;
  if (!hash) {
    throw new HttpsError("failed-precondition", "키오스크 종료 PIN이 설정되지 않았습니다.");
  }

  if (verifyPin(pin, hash)) {
    await ref.set(
      {
        exitPinFailedAttempts: 0,
        exitPinLockedAt: null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return { ok: true as const, verified: true as const };
  }

  const prev =
    typeof snap.get("exitPinFailedAttempts") === "number"
      ? (snap.get("exitPinFailedAttempts") as number)
      : 0;
  const next = prev + 1;
  const locked = next >= MAX_PIN_ATTEMPTS;
  await ref.set(
    {
      exitPinFailedAttempts: next,
      exitPinLockedAt: locked ? FieldValue.serverTimestamp() : snap.get("exitPinLockedAt") ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  if (locked) {
    throw new HttpsError(
      "resource-exhausted",
      "5회 잘못 입력해 키오스크 종료 PIN이 잠겼습니다. 학원 설정에서 해제해 주세요.",
    );
  }
  const remaining = MAX_PIN_ATTEMPTS - next;
  throw new HttpsError(
    "permission-denied",
    `키오스크 종료 PIN이 올바르지 않습니다. (${remaining}회 남음)`,
  );
});

export const submitKioskCheckIn = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const studentId =
    typeof request.data?.studentId === "string" ? request.data.studentId.trim() : "";
  if (!academyId || !studentId) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }
  const db = admin.firestore();
  await assertAcademyKioskSession(db, academyId, request.auth.uid, request.auth.token);

  const studentRef = db.doc(`academies/${academyId}/students/${studentId}`);
  const studentSnap = await studentRef.get();
  if (!studentSnap.exists) {
    throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
  }
  const studentData = studentSnap.data() as Record<string, unknown>;
  const requirePin = await getRequireStudentCheckInPin(db, academyId);

  const secretRef = studentCheckInSecretRef(db, academyId, studentId);

  if (requirePin) {
    const secretSnap = await secretRef.get();
    if (secretSnap.get("lockedAt")) {
      throw new HttpsError(
        "resource-exhausted",
        "출석 PIN이 잠겼습니다. 학부모 앱에서 PIN을 다시 설정해 주세요.",
      );
    }
    const pinHash = secretSnap.get("pinHash") as string | undefined;
    if (!pinHash) {
      const parentUserId = studentData.parentUserId;
      if (typeof parentUserId === "string" && parentUserId) {
        await maybeSendPinSetupReminder(db, academyId, parentUserId, studentId, studentData);
      }
      throw new HttpsError(
        "failed-precondition",
        "출석 PIN이 설정되지 않았습니다. 학부모에게 PIN 설정 안내가 전송됩니다.",
      );
    }
    const pin = assertFourDigitPin(request.data?.checkInPin, "출석 PIN");
    if (!verifyPin(pin, pinHash)) {
      const prev =
        typeof secretSnap.get("failedAttempts") === "number"
          ? (secretSnap.get("failedAttempts") as number)
          : 0;
      const next = prev + 1;
      const locked = next >= MAX_PIN_ATTEMPTS;
      await secretRef.set(
        {
          failedAttempts: next,
          lockedAt: locked ? FieldValue.serverTimestamp() : secretSnap.get("lockedAt") ?? null,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      if (locked) {
        throw new HttpsError(
          "resource-exhausted",
          "5회 잘못 입력해 출석 PIN이 잠겼습니다. 학부모 앱에서 다시 설정해 주세요.",
        );
      }
      const remaining = MAX_PIN_ATTEMPTS - next;
      throw new HttpsError(
        "permission-denied",
        `출석 PIN이 올바르지 않습니다. (${remaining}회 남음)`,
      );
    }
    await secretRef.set(
      { failedAttempts: 0, lockedAt: null, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }

  const sender = {
    role: "student_kiosk" as const,
    actorUid: request.auth.uid,
    source: "student_kiosk" as const,
    canBypassCooldown: false,
  };

  const result = await sendStudentAttendanceNotificationCore(db, {
    academyId,
    studentId,
    kind: "present",
    sender,
    studentData,
  });

  return { ok: true as const, attendance: result };
});

async function maybeSendPinSetupReminder(
  db: admin.firestore.Firestore,
  academyId: string,
  parentUserId: string,
  studentId: string,
  studentData: Record<string, unknown>,
): Promise<void> {
  const dayKey = new Date().toISOString().slice(0, 10);
  const rateRef = db.doc(
    `_pushRateLimits/pin_setup_reminder_${academyId}_${parentUserId}_${dayKey}`,
  );
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(rateRef);
    if (snap.exists) return false;
    tx.set(rateRef, {
      parentUserId,
      academyId,
      dayKey,
      sentAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
  if (!claimed) return;

  const studentName =
    typeof studentData.name === "string" && studentData.name ? studentData.name : "자녀";
  const body = `${studentName} 학생의 출석 PIN을 attn. 학부모 앱에서 설정해 주세요.`;

  const parentRef = db.doc(`users/${parentUserId}`);
  await parentRef.collection("dashboardBellItems").add({
    kind: "system_notice",
    academyId,
    studentId,
    studentName,
    body,
    senderRole: "academy",
    senderUid: "system",
    source: "student_kiosk",
    createdAt: FieldValue.serverTimestamp(),
  });

  const userSnap = await parentRef.get();
  if (!userSnap.exists || userSnap.get("pushNotificationsEnabled") !== true) {
    return;
  }

  const subsSnap = await parentRef.collection("pushSubscriptions").get();
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const d of subsSnap.docs) {
    const t = d.get("token");
    if (typeof t === "string" && t.length > 20 && !seen.has(t)) {
      seen.add(t);
      tokens.push(t);
    }
  }
  if (tokens.length === 0) return;

  try {
    await admin.messaging().sendEachForMulticast({
      tokens,
      data: {
        title: "attn.",
        body,
        type: "pin_setup_reminder",
        academyId,
        studentId,
      },
    });
  } catch (e) {
    logger.warn("maybeSendPinSetupReminder push failed", { parentUserId, e });
  }
}

export const setStudentCheckInPin = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const uid = request.auth.uid;
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const studentId =
    typeof request.data?.studentId === "string" ? request.data.studentId.trim() : "";
  if (!academyId || !studentId) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  const parentRef = db.doc(`academies/${academyId}/parents/${uid}`);
  const parentSnap = await parentRef.get();
  if (!parentSnap.exists || parentSnap.get("status") !== "active") {
    throw new HttpsError("permission-denied", "활성 학부모만 출석 PIN을 설정할 수 있습니다.");
  }

  const studentRef = db.doc(`academies/${academyId}/students/${studentId}`);
  const studentSnap = await studentRef.get();
  if (!studentSnap.exists) {
    throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
  }
  if (studentSnap.get("parentUserId") !== uid) {
    throw new HttpsError("permission-denied", "본인 자녀만 출석 PIN을 설정할 수 있습니다.");
  }

  const newPin = assertFourDigitPin(request.data?.newPin, "출석 PIN");
  const secretRef = studentCheckInSecretRef(db, academyId, studentId);
  const secretSnap = await secretRef.get();
  const existingHash = secretSnap.get("pinHash") as string | undefined;

  if (existingHash && !secretSnap.get("lockedAt")) {
    const currentPin = request.data?.currentPin;
    if (currentPin === undefined || currentPin === null) {
      throw new HttpsError("invalid-argument", "기존 출석 PIN을 입력해 주세요.");
    }
    const cur = assertFourDigitPin(currentPin, "기존 출석 PIN");
    if (!verifyPin(cur, existingHash)) {
      throw new HttpsError("permission-denied", "기존 출석 PIN이 올바르지 않습니다.");
    }
  }

  await secretRef.set(
    {
      pinHash: hashPin(newPin),
      failedAttempts: 0,
      lockedAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { ok: true as const, hasCheckInPin: true as const };
});
