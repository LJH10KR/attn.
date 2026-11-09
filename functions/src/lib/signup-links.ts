import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import type { AcademyPermission } from "./permissions";

/**
 * 가입 QR 링크(2-K) — 학원마다 학부모 링크·직원 링크 각 1개.
 * - 링크 주소에는 무작위 토큰만 들어가고(학원 ID 아님), 서버는 `signupLinks/{sha256(token)}`로 학원을 찾는다.
 * - 토큰 원문은 원장이 QR을 다시 볼 수 있게 `academies/{a}/secrets/signupLinks`에 둔다(둘 다 클라이언트 접근 불가).
 * - 링크별 시간당 가입 한도(서울 시각 정시 창) — 카운터는 해시 문서에 있어 다시 만들면 새로 센다.
 */

export const SIGNUP_LINK_KINDS = ["parent", "staff"] as const;
export type SignupLinkKind = (typeof SIGNUP_LINK_KINDS)[number];

/** 링크별 시간당 가입 한도 — 서버 상수(원장 설정 없음, K3) */
export const SIGNUP_HOURLY_LIMITS: Record<SignupLinkKind, number> = { parent: 100, staff: 20 };

/** 링크 관리(조회·다시 만들기·끄기) 권한 */
export const SIGNUP_LINK_MANAGE_PERMISSION: Record<SignupLinkKind, AcademyPermission> = {
  parent: "operations.parents",
  staff: "settings.members",
};

export const SIGNUP_LINK_KIND_LABELS: Record<SignupLinkKind, string> = { parent: "학부모", staff: "직원" };

export const MSG_SIGNUP_LINK_INVALID =
  "가입 링크가 올바르지 않거나 더 이상 쓸 수 없습니다. 학원에서 받은 새 가입 QR로 들어와 주세요.";
export const MSG_SIGNUP_LINK_OFF = "지금은 이 학원 가입을 받지 않습니다. 학원에 문의해 주세요.";
export const MSG_SIGNUP_ACADEMY_ARCHIVED = "이 학원은 현재 가입을 받지 않습니다.";
export const MSG_SIGNUP_RATE_LIMITED = "가입 요청이 많아 잠시 멈췄습니다. 잠시 후 다시 시도해 주세요.";

export const SIGNUP_RATE_LIMITED_INBOX_KIND = "signup_rate_limited";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function isSignupLinkKind(raw: unknown): raw is SignupLinkKind {
  return typeof raw === "string" && (SIGNUP_LINK_KINDS as readonly string[]).includes(raw);
}

/** 32바이트 무작위 → base64url 43자 */
export function newSignupToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** 형식이 맞으면 토큰, 아니면 null */
export function parseSignupToken(raw: unknown): string | null {
  const token = typeof raw === "string" ? raw.trim() : "";
  return TOKEN_RE.test(token) ? token : null;
}

export function hashSignupToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** 서울 시각 정시 창 이름 `YYYYMMDDHH` */
export function seoulHourKey(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`;
}

export type SignupRate = { windowKey: string; count: number; notifiedWindowKey: string | null };

export function readSignupRate(raw: unknown): SignupRate {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    windowKey: typeof r.windowKey === "string" ? r.windowKey : "",
    count: typeof r.count === "number" && Number.isFinite(r.count) && r.count > 0 ? Math.floor(r.count) : 0,
    notifiedWindowKey: typeof r.notifiedWindowKey === "string" ? r.notifiedWindowKey : null,
  };
}

/**
 * 한도 판단 — 이번 창에서 `limit`건까지 허용. 넘으면 거부하고, 이번 창에 원장 알림을 아직 안 보냈을 때만 `notify`.
 * 새 창이면 다시 0부터 센다.
 */
export function decideSignupQuota(
  rate: SignupRate,
  windowKey: string,
  limit: number,
): { allow: boolean; nextRate: SignupRate; notify: boolean } {
  const count = rate.windowKey === windowKey ? rate.count : 0;
  if (count < limit) {
    return {
      allow: true,
      notify: false,
      nextRate: { windowKey, count: count + 1, notifiedWindowKey: rate.notifiedWindowKey },
    };
  }
  const notify = rate.notifiedWindowKey !== windowKey;
  return { allow: false, notify, nextRate: { windowKey, count, notifiedWindowKey: windowKey } };
}

export function signupLinkHashRef(db: admin.firestore.Firestore, tokenHash: string) {
  return db.doc(`signupLinks/${tokenHash}`);
}

export function signupLinksSecretRef(db: admin.firestore.Firestore, academyId: string) {
  return db.doc(`academies/${academyId}/secrets/signupLinks`);
}

export function signupLimitInboxId(kind: SignupLinkKind, windowKey: string): string {
  return `signup-limit-${kind}-${windowKey}`;
}

type HashDocSnap = admin.firestore.DocumentSnapshot;

/** 해시 문서·학원 문서로 링크가 지금 가입을 받는지 — 아니면 안내 문구로 던짐 */
function assertLinkAccepts(
  kind: SignupLinkKind,
  hashSnap: HashDocSnap,
  academySnap: HashDocSnap | null,
): void {
  if (!hashSnap.exists || hashSnap.get("kind") !== kind) {
    throw new HttpsError("not-found", MSG_SIGNUP_LINK_INVALID);
  }
  if (hashSnap.get("enabled") !== true) {
    throw new HttpsError("failed-precondition", MSG_SIGNUP_LINK_OFF);
  }
  if (!academySnap || !academySnap.exists) {
    throw new HttpsError("not-found", MSG_SIGNUP_LINK_INVALID);
  }
  if (academySnap.get("status") === "archived") {
    throw new HttpsError("failed-precondition", MSG_SIGNUP_ACADEMY_ARCHIVED);
  }
}

function hashFromRawToken(rawToken: unknown): string {
  const token = parseSignupToken(rawToken);
  if (!token) {
    throw new HttpsError("not-found", MSG_SIGNUP_LINK_INVALID);
  }
  return hashSignupToken(token);
}

/** 토큰의 해시 문서 ID(번호 확인 코드·증표를 같은 가입 링크에 묶을 때) — 형식이 틀리면 링크 무효 안내 */
export function signupLinkHashFromToken(rawToken: unknown): string {
  return hashFromRawToken(rawToken);
}

export type ResolvedSignupLink = {
  academyId: string;
  academyName: string;
  academySnap: admin.firestore.DocumentSnapshot;
};

/** 읽기만 — 가입 화면 조회 함수가 쓰는 토큰 검사(형식 → 링크 → 종류 → 켜짐 → 학원 → archived) */
export async function resolveSignupLink(
  db: admin.firestore.Firestore,
  rawToken: unknown,
  kind: SignupLinkKind,
): Promise<ResolvedSignupLink> {
  const hashSnap = await signupLinkHashRef(db, hashFromRawToken(rawToken)).get();
  const academyId = hashSnap.exists ? hashSnap.get("academyId") : null;
  const academySnap =
    typeof academyId === "string" && academyId ? await db.doc(`academies/${academyId}`).get() : null;
  assertLinkAccepts(kind, hashSnap, academySnap);
  const name = academySnap!.get("name");
  return {
    academyId: academyId as string,
    academyName: typeof name === "string" && name.trim() ? name.trim() : "학원",
    academySnap: academySnap!,
  };
}

/**
 * 가입 직전(입력 검사를 모두 통과한 뒤) 한 건을 센다 — 트랜잭션 안에서 토큰 검사를 다시 하고 카운터를 올린다.
 * 한도를 넘으면 그 창에 처음일 때만 원장 벨 문서를 **같은 트랜잭션에서** 쓰고, commit 뒤 resource-exhausted.
 */
export async function consumeSignupQuota(
  db: admin.firestore.Firestore,
  rawToken: unknown,
  kind: SignupLinkKind,
  nowMs: number = Date.now(),
): Promise<{ academyId: string }> {
  const hashRef = signupLinkHashRef(db, hashFromRawToken(rawToken));
  const windowKey = seoulHourKey(nowMs);
  const outcome = await db.runTransaction(async (tx) => {
    const hashSnap = await tx.get(hashRef);
    const academyId = hashSnap.exists ? hashSnap.get("academyId") : null;
    const academySnap =
      typeof academyId === "string" && academyId ? await tx.get(db.doc(`academies/${academyId}`)) : null;
    assertLinkAccepts(kind, hashSnap, academySnap);
    const decision = decideSignupQuota(readSignupRate(hashSnap.get("rate")), windowKey, SIGNUP_HOURLY_LIMITS[kind]);
    tx.update(hashRef, { rate: decision.nextRate });
    if (decision.notify) {
      tx.set(db.doc(`academies/${academyId}/adminInbox/${signupLimitInboxId(kind, windowKey)}`), {
        schemaVersion: 1,
        kind: SIGNUP_RATE_LIMITED_INBOX_KIND,
        entityType: "signup_link",
        entityId: kind,
        linkKind: kind,
        windowKey,
        displayName: "",
        email: "",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return { academyId: academyId as string, allow: decision.allow, notified: decision.notify };
  });
  if (!outcome.allow) {
    if (outcome.notified) {
      await deleteSignupLimitBells(db, outcome.academyId, kind, signupLimitInboxId(kind, windowKey)).catch((e) =>
        logger.warn("consumeSignupQuota: old bell cleanup failed", { academyId: outcome.academyId, kind, e }),
      );
    }
    throw new HttpsError("resource-exhausted", MSG_SIGNUP_RATE_LIMITED);
  }
  return { academyId: outcome.academyId };
}

/** 그 링크 종류의 한도 벨 정리 — `keepId`만 남김(null이면 모두 삭제) */
export async function deleteSignupLimitBells(
  db: admin.firestore.Firestore,
  academyId: string,
  kind: SignupLinkKind,
  keepId: string | null,
): Promise<void> {
  const snap = await db
    .collection(`academies/${academyId}/adminInbox`)
    .where("kind", "==", SIGNUP_RATE_LIMITED_INBOX_KIND)
    .where("linkKind", "==", kind)
    .get();
  await Promise.all(snap.docs.filter((d) => d.id !== keepId).map((d) => d.ref.delete()));
}

type SecretEntry = { token: string; tokenHash: string };

function readSecretEntry(raw: unknown): SecretEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const token = parseSignupToken(r.token);
  if (!token || typeof r.tokenHash !== "string" || r.tokenHash !== hashSignupToken(token)) return null;
  return { token, tokenHash: r.tokenHash };
}

export type SignupLinkState = { kind: SignupLinkKind; token: string; enabled: boolean };

function newHashDoc(academyId: string, kind: SignupLinkKind, enabled: boolean, uid: string) {
  return {
    academyId,
    kind,
    enabled,
    createdAt: FieldValue.serverTimestamp(),
    createdByUid: uid,
    rate: { windowKey: "", count: 0, notifiedWindowKey: null },
  };
}

function newSecretEntry(token: string, uid: string) {
  return { token, tokenHash: hashSignupToken(token), createdAt: FieldValue.serverTimestamp(), createdByUid: uid };
}

/**
 * 링크 상태 읽기(없으면 만듦) — secrets 문서와 해시 문서를 한 트랜잭션에서 읽고 쓴다
 * (동시 첫 호출이 토큰 두 개를 만들어, 덮어써진 쪽 해시 문서가 지울 수 없는 유효 링크로 남지 않게).
 * `setEnabled`가 있으면 켜짐 상태도 같은 트랜잭션에서 바꾼다.
 */
export async function ensureSignupLink(
  db: admin.firestore.Firestore,
  academyId: string,
  kind: SignupLinkKind,
  uid: string,
  setEnabled?: boolean,
): Promise<SignupLinkState> {
  const secretRef = signupLinksSecretRef(db, academyId);
  return db.runTransaction(async (tx) => {
    const secretSnap = await tx.get(secretRef);
    const entry = readSecretEntry(secretSnap.get(kind));
    const hashSnap = entry ? await tx.get(signupLinkHashRef(db, entry.tokenHash)) : null;
    if (entry && hashSnap?.exists && hashSnap.get("academyId") === academyId && hashSnap.get("kind") === kind) {
      const enabled = setEnabled ?? hashSnap.get("enabled") === true;
      if (setEnabled !== undefined) tx.update(hashSnap.ref, { enabled: setEnabled });
      return { kind, token: entry.token, enabled };
    }
    // 처음이거나(또는 해시 문서가 사라진 어긋난 상태) — 새로 만듦
    const token = newSignupToken();
    const enabled = setEnabled ?? true;
    tx.set(signupLinkHashRef(db, hashSignupToken(token)), newHashDoc(academyId, kind, enabled, uid));
    tx.set(secretRef, { [kind]: newSecretEntry(token, uid) }, { merge: true });
    return { kind, token, enabled };
  });
}

/** 다시 만들기 — 새 토큰, 이전 해시 문서 삭제(즉시 무효), 켜짐 상태 이어받음. 그 종류 한도 벨 삭제 */
export async function regenerateSignupLinkToken(
  db: admin.firestore.Firestore,
  academyId: string,
  kind: SignupLinkKind,
  uid: string,
): Promise<SignupLinkState> {
  const secretRef = signupLinksSecretRef(db, academyId);
  const state = await db.runTransaction(async (tx) => {
    const secretSnap = await tx.get(secretRef);
    const entry = readSecretEntry(secretSnap.get(kind));
    const oldHashSnap = entry ? await tx.get(signupLinkHashRef(db, entry.tokenHash)) : null;
    const enabled = oldHashSnap?.exists ? oldHashSnap.get("enabled") === true : true;
    if (oldHashSnap?.exists) tx.delete(oldHashSnap.ref);
    const token = newSignupToken();
    tx.set(signupLinkHashRef(db, hashSignupToken(token)), newHashDoc(academyId, kind, enabled, uid));
    tx.set(secretRef, { [kind]: newSecretEntry(token, uid) }, { merge: true });
    return { kind, token, enabled };
  });
  await deleteSignupLimitBells(db, academyId, kind, null).catch((e) =>
    logger.warn("regenerateSignupLink: bell cleanup failed", { academyId, kind, e }),
  );
  return state;
}

/** 학원 삭제 때 — 해시 문서와 secrets 문서 정리 */
export async function deleteAcademySignupLinks(db: admin.firestore.Firestore, academyId: string): Promise<void> {
  const secretRef = signupLinksSecretRef(db, academyId);
  const snap = await secretRef.get();
  if (!snap.exists) return;
  const refs = SIGNUP_LINK_KINDS.flatMap((k) => {
    const e = readSecretEntry(snap.get(k));
    return e ? [signupLinkHashRef(db, e.tokenHash)] : [];
  });
  await Promise.all([...refs.map((r) => r.delete()), secretRef.delete()]);
}
