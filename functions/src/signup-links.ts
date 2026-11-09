import * as admin from "firebase-admin";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import { assertPermission } from "./lib/academy-access";
import { parentLinkSettingsRef, readAutoLinkEnabled } from "./lib/parent-auto-link";
import {
  ensureSignupLink,
  isSignupLinkKind,
  regenerateSignupLinkToken,
  SIGNUP_LINK_MANAGE_PERMISSION,
  type SignupLinkKind,
} from "./lib/signup-links";

/**
 * 가입 QR 링크 관리(2-K) — 학부모 링크는 학부모 관리(`operations.parents`), 직원 링크는 멤버 초대/권한 관리(`settings.members`).
 * 화면은 토큰을 받아 `{origin}/join/{kind}?token=…`을 만든다(QR은 기기 안에서 그림).
 */

function requireString(raw: unknown, message: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.includes("/")) {
    throw new HttpsError("invalid-argument", message);
  }
  return s;
}

async function authorize(request: CallableRequest): Promise<{ academyId: string; kind: SignupLinkKind; uid: string }> {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireString(request.data?.academyId, "학원 ID가 필요합니다.");
  const kind = request.data?.kind;
  if (!isSignupLinkKind(kind)) {
    throw new HttpsError("invalid-argument", "링크 종류가 올바르지 않습니다.");
  }
  await assertPermission(
    admin.firestore(),
    academyId,
    request.auth.uid,
    request.auth.token,
    SIGNUP_LINK_MANAGE_PERMISSION[kind],
  );
  return { academyId, kind, uid: request.auth.uid };
}

/** 학부모 링크 응답에 학원 설정 "번호 확인된 학부모 자동 연결"(2-L ★6)을 함께 싣는다 — 가입 QR 카드 아래 스위치 */
async function withParentSettings(academyId: string, kind: SignupLinkKind) {
  return kind === "parent" ? { autoLinkVerifiedParents: await readAutoLinkEnabled(admin.firestore(), academyId) } : {};
}

/** 링크 보기 — 처음이면 만든다(지연 생성) */
export const getSignupLink = onCall(async (request) => {
  const { academyId, kind, uid } = await authorize(request);
  const state = await ensureSignupLink(admin.firestore(), academyId, kind, uid);
  return { ok: true as const, ...state, ...(await withParentSettings(academyId, kind)) };
});

/** 다시 만들기 — 이전 링크·QR은 바로 무효, 한도도 새로 셈 */
export const regenerateSignupLink = onCall(async (request) => {
  const { academyId, kind, uid } = await authorize(request);
  const state = await regenerateSignupLinkToken(admin.firestore(), academyId, kind, uid);
  return { ok: true as const, ...state, ...(await withParentSettings(academyId, kind)) };
});

/** 가입 받기 끄기·켜기 — 같은 QR을 그대로 다시 켤 수 있음 */
export const setSignupLinkEnabled = onCall(async (request) => {
  const { academyId, kind, uid } = await authorize(request);
  const enabled = request.data?.enabled;
  if (typeof enabled !== "boolean") {
    throw new HttpsError("invalid-argument", "켜기·끄기 값이 올바르지 않습니다.");
  }
  const state = await ensureSignupLink(admin.firestore(), academyId, kind, uid, enabled);
  return { ok: true as const, ...state, ...(await withParentSettings(academyId, kind)) };
});

/**
 * 학원 설정 "번호 확인된 학부모 자동 연결"(2-L ★6, 기본 켜짐) — 학부모 관리 권한.
 * 끄면 번호가 확인돼도 연결하지 않고 승인 대기(승인 화면에 "번호 확인됨 · 일치 원생" 후보).
 */
export const setParentAutoLink = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId = requireString(request.data?.academyId, "학원 ID가 필요합니다.");
  const enabled = request.data?.enabled;
  if (typeof enabled !== "boolean") {
    throw new HttpsError("invalid-argument", "켜기·끄기 값이 올바르지 않습니다.");
  }
  const db = admin.firestore();
  await assertPermission(db, academyId, request.auth.uid, request.auth.token, "operations.parents");
  await parentLinkSettingsRef(db, academyId).set(
    { autoLinkVerifiedParents: enabled, updatedAt: FieldValue.serverTimestamp(), updatedByUid: request.auth.uid },
    { merge: true },
  );
  return { ok: true as const, autoLinkVerifiedParents: enabled };
});
