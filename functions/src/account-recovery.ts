import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import {
  foundLoginAccountOf,
  memberRoleOf,
  passwordResetMatch,
  recoveryIndexKeys,
  remainingFloorMs,
  resetLoginIdCounterKey,
  RECOVERY_DUMMY_INDEX_KEY,
  RECOVERY_RESET_STATUSES,
} from "./lib/account-recovery";
import { writeInfoBell } from "./lib/admin-inbox-info";
import { assertFreshAppCheck, ONE_SHOT_APP_CHECK_OPTIONS } from "./lib/app-check";
import { attnLoginIndexPath } from "./lib/attn-id";
import { LOGIN_THROTTLE_RESET, loginThrottleFields } from "./lib/login-throttle";
import { hasLoginSecret, passwordSecretFields } from "./lib/password-hash";
import {
  counterTtl,
  hashProofSecret,
  isAccountPhoneVerified,
  MSG_PHONE_PROOF_INVALID,
  newPhoneProof,
  octomoPhoneKey,
  parsePhoneProof,
  phoneCounterRef,
  phoneVerificationRef,
  readCount,
  readPhoneProofInTx,
} from "./lib/phone-verification";
import {
  PASSWORD_RESET_CHECKS_PER_LOGIN_ID_PER_DAY,
  PASSWORD_RESET_TICKET_TTL_MS,
  RECOVERY_RESPONSE_FLOOR_MS,
} from "./lib/phone-verification-limits";

/**
 * 아이디·비밀번호 찾기(2-M, L3-2·M1) — 로그인 전 공개 기능이라 가입과 같은 보호:
 * 문자 번호 확인 증표(목적 `find_login_id`·`reset_password`, 범위 `recovery`) + App Check 강제·1회용 토큰.
 * - 아이디 찾기: 그 번호로 확인된 모든 학부모·직원 계정(모든 학원)의 아이디·학원·종류(Google은 "Google로 로그인").
 * - 비밀번호 찾기: ① 아이디 + 번호 + 증표 → 맞으면 10분 1회용 재설정 표 ② 표 + 새 비밀번호.
 *   실패는 이유를 나누지 않고(`no_match`), 없는 아이디도 같은 수를 읽고, 응답 시간 하한을 둔다(아이디 존재 노출 방지).
 *   증표는 ①에서 맞든 틀리든 소비 — 시도마다 본인 휴대폰 문자 확인 1번. 아이디별 하루 5번.
 *   재설정은 비밀번호·잠금만 바꾸고 **계정 상태·클레임은 그대로**(대기 계정이 스스로 활성되지 않게), 다른 기기 로그인은 끊는다.
 */

const MIN_PASSWORD_LENGTH = 6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function memberCollection(role: "parent" | "teacher"): "parents" | "staff" {
  return role === "parent" ? "parents" : "staff";
}

function readPhoneKey(raw: unknown): string {
  const key = octomoPhoneKey(raw);
  if (!key) {
    throw new HttpsError("invalid-argument", "010으로 시작하는 휴대폰 번호를 입력해 주세요.");
  }
  return key;
}

type FoundAccount = {
  kind: "parent" | "teacher";
  academyName: string;
  loginId: string | null;
  google: boolean;
  inactive: boolean;
};

/** 아이디 찾기 — 증표 1회, 그 번호로 확인된 계정 전부(학원을 넘어, 컬렉션 그룹 조회) */
export const findLoginIdsByPhone = onCall(ONE_SHOT_APP_CHECK_OPTIONS, async (request) => {
  assertFreshAppCheck(request);
  const phoneKey = readPhoneKey(request.data?.phone);
  const db = admin.firestore();
  await db.runTransaction(async (tx) => {
    const proof = await readPhoneProofInTx(tx, db, request.data?.phoneProof, {
      purposes: ["find_login_id"],
      phoneKey,
      recovery: true,
    });
    proof.markUsed("recovery:find_login_id");
  });

  const [parents, staff] = await Promise.all([
    db.collectionGroup("parents").where("phoneVerifiedKey", "==", phoneKey).limit(20).get(),
    db.collectionGroup("staff").where("phoneVerifiedKey", "==", phoneKey).limit(20).get(),
  ]);
  const found = [...parents.docs, ...staff.docs].flatMap((d) => {
    const f = foundLoginAccountOf(d.ref.path, d.data(), phoneKey);
    return f ? [f] : [];
  });
  const academyIds = [...new Set(found.map((f) => f.academyId))];
  const academySnaps = academyIds.length > 0 ? await db.getAll(...academyIds.map((id) => db.doc(`academies/${id}`))) : [];
  // 학원 문서가 있는 결과만(2-N N9 ④) — `getAll`은 없는 문서도 돌려주므로 `exists`로 거른다
  const academyName = new Map(
    academySnaps
      .filter((s) => s.exists)
      .map((s) => [s.id, typeof s.get("name") === "string" ? (s.get("name") as string) : ""]),
  );
  const accounts: FoundAccount[] = found
    .filter((f) => academyName.has(f.academyId))
    .map((f) => ({
      kind: f.kind,
      academyName: academyName.get(f.academyId) || "학원",
      loginId: f.loginId,
      google: f.google,
      inactive: f.inactive,
    }))
    .sort((a, b) => a.academyName.localeCompare(b.academyName, "ko") || a.kind.localeCompare(b.kind));
  logger.info("findLoginIdsByPhone", { count: accounts.length });
  return { status: "ok" as const, accounts };
});

type VerifyResult =
  | { status: "ok"; ticket: string; expiresAtMs: number }
  | { status: "google" | "no_match" | "limited" };

/**
 * 비밀번호 찾기 ① — 아이디 + 번호 + 증표. 아이디별 하루 한도 → 증표 소비(맞든 틀리든) → 색인 2개·계정·비밀번호 문서를
 * 항상 같은 수로 읽고 판단 → 맞으면 재설정 표. 실패 4종(아이디 없음·번호 다름·미확인·대상 아닌 상태)은 같은 `no_match`.
 * 증표 형식·만료·용도 오류는 아이디와 무관한 오류라 그대로 던진다(아이디를 읽기 전에 판단).
 */
export const verifyPasswordResetTarget = onCall(ONE_SHOT_APP_CHECK_OPTIONS, async (request): Promise<VerifyResult> => {
  assertFreshAppCheck(request);
  const startedAt = Date.now();
  const keys = recoveryIndexKeys(request.data?.loginId);
  if (!keys) {
    throw new HttpsError("invalid-argument", "로그인 ID를 입력해 주세요.");
  }
  const phoneKey = readPhoneKey(request.data?.phone);
  const parsedProof = parsePhoneProof(request.data?.phoneProof);
  if (!parsedProof) {
    throw new HttpsError("failed-precondition", MSG_PHONE_PROOF_INVALID);
  }

  const db = admin.firestore();
  const counterRef = phoneCounterRef(db, resetLoginIdCounterKey(keys[0], startedAt));
  const verificationRef = phoneVerificationRef(db, parsedProof.verificationId);
  const ticket = newPhoneProof(parsedProof.verificationId);
  const ticketExpiresAtMs = startedAt + PASSWORD_RESET_TICKET_TTL_MS;

  const outcome = await db.runTransaction(async (tx): Promise<VerifyResult> => {
    const counterSnap = await tx.get(counterRef);
    const used = readCount(counterSnap.get("count"));
    if (used >= PASSWORD_RESET_CHECKS_PER_LOGIN_ID_PER_DAY) return { status: "limited" };
    // 증표(형식·만료·이미 씀·용도·번호) — 아이디와 무관한 판단을 먼저
    await readPhoneProofInTx(tx, db, request.data?.phoneProof, {
      purposes: ["reset_password"],
      phoneKey,
      recovery: true,
    }, startedAt);

    // 색인 2개 → 계정·비밀번호 문서 2개(없는 아이디는 빈 경로를 읽어 수를 맞춤)
    const [idxA, idxB] = await tx.getAll(db.doc(attnLoginIndexPath(keys[0])), db.doc(attnLoginIndexPath(keys[1])));
    const idx = idxA.exists ? idxA : idxB.exists ? idxB : null;
    const role = memberRoleOf(idx?.get("role"));
    const academyId = idx?.get("academyId");
    const authUid = idx?.get("authUid");
    const target =
      role && typeof academyId === "string" && academyId && !academyId.includes("/") &&
      typeof authUid === "string" && authUid && !authUid.includes("/")
        ? { role, academyId, uid: authUid }
        : null;
    const memberRef = target
      ? db.doc(`academies/${target.academyId}/${memberCollection(target.role)}/${target.uid}`)
      : db.doc(attnLoginIndexPath(RECOVERY_DUMMY_INDEX_KEY));
    const secretRef = target
      ? memberRef.collection("secrets").doc("login")
      : phoneCounterRef(db, RECOVERY_DUMMY_INDEX_KEY);
    const [memberSnap, secretSnap] = await tx.getAll(memberRef, secretRef);

    const match = passwordResetMatch({
      indexRole: target?.role ?? null,
      member: target && memberSnap.exists ? (memberSnap.data() ?? null) : null,
      hasPassword: target ? hasLoginSecret(secretSnap.data()) : false,
      proofPhoneKey: phoneKey,
    });

    tx.set(counterRef, { count: used + 1, ttlAt: counterTtl(startedAt) }, { merge: true });
    tx.update(verificationRef, {
      usedAt: FieldValue.serverTimestamp(),
      usedByUid: "recovery:reset_password",
      ...(match === "ok" && target
        ? {
          resetTicketHash: ticket.proofHash,
          resetTicketExpiresAt: Timestamp.fromMillis(ticketExpiresAtMs),
          resetTicketUsedAt: null,
          resetTarget: {
            academyId: target.academyId,
            uid: target.uid,
            role: target.role,
            loginId: typeof idx?.get("loginId") === "string" ? idx.get("loginId") : idx?.id ?? "",
          },
        }
        : {}),
    });
    if (match === "ok") return { status: "ok", ticket: ticket.proof, expiresAtMs: ticketExpiresAtMs };
    return { status: match };
  });

  await sleep(remainingFloorMs(startedAt, Date.now(), RECOVERY_RESPONSE_FLOOR_MS));
  logger.info("verifyPasswordResetTarget", { status: outcome.status });
  return outcome;
});

type ResetResult =
  | { status: "ok"; role: "parent" | "teacher"; loginId: string }
  | { status: "expired" | "no_match" };

/**
 * 비밀번호 찾기 ② — 재설정 표 + 새 비밀번호. 한 트랜잭션에서 표(해시·만료·미사용)와 계정(상태·확인된 번호)을 다시 확인하고
 * 새 해시 저장·잠금 해제·표 사용 처리. 그 뒤 다른 기기 로그인 끊기·원장 벨(전화번호 없음).
 * 계정 상태·클레임은 바꾸지 않는다(B3).
 */
export const resetPasswordWithPhone = onCall(ONE_SHOT_APP_CHECK_OPTIONS, async (request): Promise<ResetResult> => {
  assertFreshAppCheck(request);
  const newPassword = typeof request.data?.newPassword === "string" ? request.data.newPassword : "";
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new HttpsError("invalid-argument", `새 비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
  }
  const parsed = parsePhoneProof(request.data?.ticket);
  if (!parsed) return { status: "expired" };

  const db = admin.firestore();
  const verificationRef = phoneVerificationRef(db, parsed.verificationId);
  const secretFields = await passwordSecretFields(newPassword);
  const nowMs = Date.now();

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(verificationRef);
    const target = snap.get("resetTarget") as Record<string, unknown> | undefined;
    const expiresAt = snap.get("resetTicketExpiresAt");
    const role = memberRoleOf(target?.role);
    const ticketOk =
      snap.exists &&
      snap.get("purpose") === "reset_password" &&
      typeof snap.get("resetTicketHash") === "string" &&
      snap.get("resetTicketHash") === hashProofSecret(parsed.secret) &&
      snap.get("resetTicketUsedAt") == null &&
      expiresAt instanceof Timestamp &&
      expiresAt.toMillis() > nowMs &&
      role !== null &&
      typeof target?.academyId === "string" &&
      typeof target?.uid === "string";
    if (!ticketOk) return { status: "expired" as const };

    const academyId = target!.academyId as string;
    const uid = target!.uid as string;
    const memberRef = db.doc(`academies/${academyId}/${memberCollection(role!)}/${uid}`);
    const memberSnap = await tx.get(memberRef);
    const member = memberSnap.data() ?? {};
    // 표를 받은 뒤 계정이 바뀌었으면(상태·번호) 재설정하지 않음 — 표는 쓴 것으로
    const stillOk =
      memberSnap.exists &&
      (RECOVERY_RESET_STATUSES as readonly unknown[]).includes(member.status) &&
      isAccountPhoneVerified(member) &&
      member.phoneVerifiedKey === snap.get("phoneKey");
    tx.update(verificationRef, { resetTicketUsedAt: FieldValue.serverTimestamp() });
    if (!stillOk) return { status: "no_match" as const };

    tx.set(
      memberRef.collection("secrets").doc("login"),
      { ...secretFields, ...loginThrottleFields(LOGIN_THROTTLE_RESET) },
      { merge: true },
    );
    tx.update(memberRef, {
      passwordResetAt: FieldValue.serverTimestamp(),
      passwordResetVia: "phone",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      status: "ok" as const,
      role: role!,
      academyId,
      uid,
      displayName: typeof member.displayName === "string" ? member.displayName : "",
      loginId: typeof target!.loginId === "string" ? (target!.loginId as string) : "",
    };
  });

  if (result.status !== "ok") return { status: result.status };

  // 다른 기기 로그인 모두 끊기(M1-3) — 실패하면 오류로 알림(비밀번호는 이미 바뀜)
  await admin.auth().revokeRefreshTokens(result.uid);
  await writeInfoBell(db, result.academyId, `pw-reset-${result.uid}`, {
    kind: "member_password_reset",
    entityType: result.role === "parent" ? "parent" : "teacher",
    entityId: result.uid,
    displayName: result.displayName || "이름 미입력",
  }, "replace").catch((e) => logger.warn("resetPasswordWithPhone: 원장 벨 실패(무시)", { academyId: result.academyId, e }));
  logger.info("resetPasswordWithPhone", { academyId: result.academyId, role: result.role });
  return { status: "ok", role: result.role, loginId: result.loginId };
});
