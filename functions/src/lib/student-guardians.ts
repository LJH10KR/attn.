import * as crypto from "node:crypto";
import { HttpsError } from "firebase-functions/v2/https";
import { assertKrPhoneRequired, digitsOnlyKrPhone } from "./kr-phone";

/**
 * 원생 보호자 연락처 — `students/{id}.guardians[]`가 보호자 정보의 원본이다.
 * `guardianPhones`(번호 매칭 쿼리용)·`parentUids`(보안 규칙·푸시 대상)는 이 목록에서 서버가 파생하며,
 * 보호자를 쓰는 모든 서버 경로가 `deriveGuardianFields`로 같은 쓰기 안에서 함께 저장한다.
 */

export const MAX_GUARDIANS = 5;
const MAX_GUARDIAN_NAME_LENGTH = 30;
const GUARDIAN_ID_RE = /^g_[A-Za-z0-9_-]{4,40}$/;

export type Guardian = {
  id: string;
  /** `meta/options.guardianRelations` 선택지 id — 지운 선택지면 화면에서 "관계 미지정" */
  relationId: string | null;
  name: string | null;
  /** 저장 형식 010-1234-5678 */
  phone: string;
  isPrimary: boolean;
  /** 연결된 학부모 앱 계정 — 연결·해제 함수만 바꾼다(클라이언트 입력은 무시) */
  linkedParentUid: string | null;
};

/** 번호 비교·색인 키 — 숫자만 */
export function guardianPhoneKey(phone: string): string {
  return digitsOnlyKrPhone(phone);
}

/** 저장된 학생 문서의 보호자 목록 — 형식이 어긋난 항목은 버린다 */
export function readGuardians(raw: unknown): Guardian[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): Guardian[] => {
    const g = x as Record<string, unknown> | null;
    if (!g || typeof g.id !== "string" || typeof g.phone !== "string") return [];
    return [{
      id: g.id,
      relationId: typeof g.relationId === "string" && g.relationId ? g.relationId : null,
      name: typeof g.name === "string" && g.name ? g.name : null,
      phone: g.phone,
      isPrimary: g.isPrimary === true,
      linkedParentUid:
        typeof g.linkedParentUid === "string" && g.linkedParentUid ? g.linkedParentUid : null,
    }];
  });
}

export function deriveGuardianFields(guardians: readonly Guardian[]): {
  guardianPhones: string[];
  parentUids: string[];
} {
  const phones = new Set<string>();
  const uids = new Set<string>();
  for (const g of guardians) {
    const key = guardianPhoneKey(g.phone);
    if (key) phones.add(key);
    if (g.linkedParentUid) uids.add(g.linkedParentUid);
  }
  return { guardianPhones: [...phones].sort(), parentUids: [...uids].sort() };
}

export function newGuardianId(): string {
  return `g_${crypto.randomBytes(6).toString("base64url")}`;
}

export const LINKED_GUARDIAN_REMOVE_MSG =
  "앱에 연결된 보호자입니다. 학부모 관리에서 연결을 해제한 뒤 삭제해 주세요.";

/**
 * 화면이 보낸 보호자 목록 검증. `existing`(트랜잭션 안에서 읽은 저장 값)과 id가 같은 항목만
 * `linkedParentUid`를 이어받는다 — 해제된 연결이 저장 경합으로 되살아나지 않게.
 * 앱 계정이 연결된 항목은 지울 수 없다(연결 해제는 학부모 관리 권한의 `unlinkParentFromStudent`만).
 * 수정 때 목록을 보내지 않은 요청은 호출 측(`saveStudent`)이 보호자를 바꾸지 않으므로 여기 오지 않는다.
 * 연결된 항목의 번호·이름·관계 수정은 허용한다.
 * 대표는 정확히 1명(지정이 없으면 첫 번째), 같은 학생 안에서 번호 중복 불가.
 */
export function parseGuardiansInput(
  raw: unknown,
  existing: readonly Guardian[],
  relationIds: ReadonlySet<string>,
): Guardian[] {
  if (raw === undefined || raw === null) raw = [];
  if (!Array.isArray(raw)) {
    throw new HttpsError("invalid-argument", "보호자 목록이 올바르지 않습니다.");
  }
  if (raw.length > MAX_GUARDIANS) {
    throw new HttpsError("invalid-argument", `보호자는 최대 ${MAX_GUARDIANS}명까지 등록할 수 있습니다.`);
  }
  const existingById = new Map(existing.map((g) => [g.id, g]));
  const seenIds = new Set<string>();
  const seenPhones = new Set<string>();

  const parsed = raw.map((x): Guardian => {
    const g = (x ?? {}) as Record<string, unknown>;
    const phone = assertKrPhoneRequired(g.phone);
    const key = guardianPhoneKey(phone);
    if (seenPhones.has(key)) {
      throw new HttpsError("invalid-argument", "같은 번호의 보호자가 두 번 들어 있습니다.");
    }
    seenPhones.add(key);

    const relationRaw = g.relationId;
    let relationId: string | null = null;
    if (typeof relationRaw === "string" && relationRaw) {
      if (!relationIds.has(relationRaw)) {
        throw new HttpsError("failed-precondition", "선택한 보호자 관계가 삭제되었습니다. 다시 선택해 주세요.");
      }
      relationId = relationRaw;
    }

    const name = typeof g.name === "string" ? g.name.trim() : "";
    if (name.length > MAX_GUARDIAN_NAME_LENGTH) {
      throw new HttpsError("invalid-argument", `보호자 이름은 ${MAX_GUARDIAN_NAME_LENGTH}자 이하로 입력해 주세요.`);
    }

    const prev =
      typeof g.id === "string" && GUARDIAN_ID_RE.test(g.id) && !seenIds.has(g.id)
        ? existingById.get(g.id)
        : undefined;
    const id = prev ? prev.id : newGuardianId();
    seenIds.add(id);

    return {
      id,
      relationId,
      name: name || null,
      phone,
      isPrimary: g.isPrimary === true,
      linkedParentUid: prev?.linkedParentUid ?? null,
    };
  });

  if (existing.some((g) => g.linkedParentUid && !seenIds.has(g.id))) {
    throw new HttpsError("failed-precondition", LINKED_GUARDIAN_REMOVE_MSG);
  }

  const primaryCount = parsed.filter((g) => g.isPrimary).length;
  if (primaryCount > 1) {
    throw new HttpsError("invalid-argument", "대표 보호자는 한 명만 지정할 수 있습니다.");
  }
  if (parsed.length > 0 && primaryCount === 0) {
    parsed[0]!.isPrimary = true;
  }
  return parsed;
}
