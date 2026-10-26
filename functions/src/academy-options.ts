import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { assertPermission } from "./lib/academy-access";
import type { AcademyPermission } from "./lib/permissions";

/**
 * 학원 선택지 목록 — `academies/{academyId}/meta/options`에 종류별 `{id, label}[]`.
 * 다른 문서는 label이 아니라 id를 저장하므로 이름을 바꿔도 따로 갱신할 필요가 없고,
 * 지운 선택지를 가리키는 id는 화면에서 "없음"으로 보인다.
 * 강의실·청구 항목 등은 해당 단계에서 종류만 추가한다.
 */
export const OPTION_LIST_KINDS = {
  jobTitles: { permission: "settings.staff", maxItems: 30 },
} as const satisfies Record<string, { permission: AcademyPermission; maxItems: number }>;

export type OptionListKind = keyof typeof OPTION_LIST_KINDS;

export type OptionItem = { id: string; label: string };

const MAX_LABEL_LENGTH = 20;
const OPTION_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function academyOptionsRef(db: admin.firestore.Firestore, academyId: string) {
  return db.doc(`academies/${academyId}/meta/options`);
}

function isOptionListKind(raw: unknown): raw is OptionListKind {
  return typeof raw === "string" && Object.prototype.hasOwnProperty.call(OPTION_LIST_KINDS, raw);
}

export function readOptionItems(raw: unknown): OptionItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const id = (x as { id?: unknown })?.id;
    const label = (x as { label?: unknown })?.label;
    return typeof id === "string" && typeof label === "string" ? [{ id, label }] : [];
  });
}

/** 순서 그대로 저장 — id 없는 항목은 새로 발급, 이름 중복·빈 이름은 거부 */
function parseOptionItems(raw: unknown, maxItems: number): OptionItem[] {
  if (!Array.isArray(raw)) {
    throw new HttpsError("invalid-argument", "선택지 목록이 올바르지 않습니다.");
  }
  if (raw.length > maxItems) {
    throw new HttpsError("invalid-argument", `선택지는 최대 ${maxItems}개까지 만들 수 있습니다.`);
  }
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  return raw.map((x) => {
    const label = typeof x?.label === "string" ? x.label.trim() : "";
    if (!label || label.length > MAX_LABEL_LENGTH) {
      throw new HttpsError("invalid-argument", `선택지 이름을 1~${MAX_LABEL_LENGTH}자로 입력해 주세요.`);
    }
    const labelKey = label.toLowerCase();
    if (seenLabels.has(labelKey)) {
      throw new HttpsError("invalid-argument", `'${label}' 선택지가 이미 있습니다.`);
    }
    seenLabels.add(labelKey);
    let id = typeof x?.id === "string" ? x.id : "";
    if (id && (!OPTION_ID_RE.test(id) || seenIds.has(id))) {
      throw new HttpsError("invalid-argument", "선택지 목록이 올바르지 않습니다.");
    }
    if (!id) {
      id = crypto.randomBytes(6).toString("base64url");
    }
    seenIds.add(id);
    return { id, label };
  });
}

/** 선택지 목록 전체 저장(추가·이름 변경·순서 변경·삭제를 한 번에) */
export const saveAcademyOptionList = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const academyId =
    typeof request.data?.academyId === "string" ? request.data.academyId.trim() : "";
  const kind = request.data?.kind;
  if (!academyId || !isOptionListKind(kind)) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }
  const spec = OPTION_LIST_KINDS[kind];
  const items = parseOptionItems(request.data?.items, spec.maxItems);

  const db = admin.firestore();
  await assertPermission(db, academyId, request.auth.uid, request.auth.token, spec.permission);

  await academyOptionsRef(db, academyId).set(
    { [kind]: items, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return { ok: true as const, items };
});
