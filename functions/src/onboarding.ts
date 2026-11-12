import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { resolveAcademyActor } from "./lib/academy-access";
import { isOnboardingAction, onboardingView, type OnboardingAction } from "./lib/onboarding";

/**
 * 홈 "시작하기" 체크리스트(2-M) — 원장만(M2-2, 권한을 모두 가진 직원도 거부).
 * 기록 `academies/{a}/meta/onboarding`: `parentLinkSharedAt`·`noStaffAt`·`hiddenAt`·`reopenedAt`(서버만).
 * 완료 기준(M2-1): 반 ≥1 · 원생 ≥1 · 연결 학부모 ≥1 또는 QR 공유 버튼 누름 · 직원(게스트 제외) ≥1 또는 "직원 없이 운영".
 */

function requireAcademyId(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.includes("/")) {
    throw new HttpsError("invalid-argument", "학원 ID가 필요합니다.");
  }
  return s;
}

async function assertOwner(db: admin.firestore.Firestore, academyId: string, uid: string | undefined): Promise<void> {
  if (!uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const actor = await resolveAcademyActor(db, academyId, uid);
  if (actor?.kind !== "owner") {
    throw new HttpsError("permission-denied", "원장만 볼 수 있습니다.");
  }
}

function onboardingRef(db: admin.firestore.Firestore, academyId: string) {
  return db.doc(`academies/${academyId}/meta/onboarding`);
}

async function readView(db: admin.firestore.Firestore, academyId: string) {
  const base = `academies/${academyId}`;
  const [classes, students, linkedParents, staff, rec] = await Promise.all([
    db.collection(`${base}/classes`).count().get(),
    db.collection(`${base}/students`).count().get(),
    db.collection(`${base}/parents`).where("status", "==", "active").count().get(),
    db.collection(`${base}/staff`).where("isGuest", "==", false).count().get(),
    onboardingRef(db, academyId).get(),
  ]);
  const has = (k: string) => rec.get(k) != null;
  return onboardingView(
    {
      classes: classes.data().count,
      students: students.data().count,
      linkedParents: linkedParents.data().count,
      staff: staff.data().count,
    },
    {
      parentLinkShared: has("parentLinkSharedAt"),
      noStaff: has("noStaffAt"),
      hidden: has("hiddenAt"),
      reopened: has("reopenedAt"),
    },
  );
}

export const getAcademyOnboarding = onCall(async (request) => {
  const academyId = requireAcademyId(request.data?.academyId);
  const db = admin.firestore();
  await assertOwner(db, academyId, request.auth?.uid);
  return { ok: true as const, ...(await readView(db, academyId)) };
});

function patchFor(action: OnboardingAction): Record<string, unknown> {
  const now = FieldValue.serverTimestamp();
  switch (action) {
  case "parent_link_shared":
    return { parentLinkSharedAt: now };
  case "no_staff":
    return { noStaffAt: now };
  case "undo_no_staff":
    return { noStaffAt: FieldValue.delete() };
  case "hide":
    return { hiddenAt: now, reopenedAt: FieldValue.delete() };
  case "show":
    return { hiddenAt: FieldValue.delete(), reopenedAt: now };
  }
}

export const updateAcademyOnboarding = onCall(async (request) => {
  const academyId = requireAcademyId(request.data?.academyId);
  const action = request.data?.action;
  if (!isOnboardingAction(action)) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }
  const db = admin.firestore();
  await assertOwner(db, academyId, request.auth?.uid);
  const ref = onboardingRef(db, academyId);
  if (action === "parent_link_shared") {
    // 처음 누른 시각만 남긴다
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.get("parentLinkSharedAt") != null) return;
      tx.set(ref, { ...patchFor(action), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
  } else {
    await ref.set({ ...patchFor(action), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  return { ok: true as const, ...(await readView(db, academyId)) };
});
