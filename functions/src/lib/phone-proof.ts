import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import {
  MSG_PHONE_PROOF_MISMATCH,
  octomoPhoneKey,
  readPhoneProofInTx,
  type PhoneProofExpectation,
  type PhoneVerificationPurpose,
} from "./phone-verification";
import { signupLinkHashFromToken } from "./signup-links";

/**
 * 가입·번호 변경 함수가 받는 확인 증표(`phoneProof`) 도우미(2-L).
 * 증표가 없으면(건너뛰기·한도·실패) 번호 확인 없이 진행 — 가입은 승인 대기.
 * 증표가 있는데 쓸 수 없으면 오류(조용히 미확인으로 바꾸지 않음 — 화면이 다시 확인하거나 건너뛰기를 고르게).
 */

/** 요청의 증표 — 비어 있으면 null */
export function readOptionalPhoneProof(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/** 가입 증표 기대값 — 같은 가입 링크·같은 번호·가입 목적 */
export function signupProofExpectation(
  rawToken: unknown,
  purpose: Extract<PhoneVerificationPurpose, "parent_signup" | "staff_signup">,
  phone: string,
): PhoneProofExpectation {
  const phoneKey = octomoPhoneKey(phone);
  if (!phoneKey) throw new HttpsError("failed-precondition", MSG_PHONE_PROOF_MISMATCH);
  return { purposes: [purpose], phoneKey, linkHash: signupLinkHashFromToken(rawToken) };
}

/** 번호 변경 증표 기대값 — 같은 계정·같은 번호 */
export function accountProofExpectation(uid: string, phone: string): PhoneProofExpectation {
  const phoneKey = octomoPhoneKey(phone);
  if (!phoneKey) throw new HttpsError("failed-precondition", MSG_PHONE_PROOF_MISMATCH);
  return { purposes: ["phone_change"], phoneKey, uid };
}

/**
 * 계정을 만들기 전(한도 차감·Auth 생성 전) 미리 확인 — 읽기만(소비는 계정 쓰기 트랜잭션에서 `readPhoneProofInTx`).
 * 쓸 수 없는 증표로 가입 한도를 쓰거나 Auth 계정을 만들었다 지우지 않게.
 */
export async function assertPhoneProofUsable(
  db: admin.firestore.Firestore,
  rawProof: string,
  expect: PhoneProofExpectation,
): Promise<void> {
  await db.runTransaction(async (tx) => {
    await readPhoneProofInTx(tx, db, rawProof, expect);
  }, { readOnly: true });
}
