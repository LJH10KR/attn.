"use client";

import { FirebaseError } from "firebase/app";
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
} from "firebase/auth";
import { WITHDRAWAL_TEXT } from "@/lib/auth/account-withdrawal-text";
import { getFirebaseAuth } from "@/lib/firebase/client-app";
import { reauthenticateMemberWithPassword } from "@/lib/firebase/member-reauth";

/**
 * 되돌릴 수 없는 작업(2-N 탈퇴·학원 삭제) 직전 본인 재확인 — 서버가 ID 토큰 `auth_time`이 5분 안인지 본다.
 * - member: 로그인 ID 계정(Auth 비밀번호는 무작위) → `reauthenticateMember` 커스텀 토큰으로 다시 로그인
 * - owner: 이메일 원장 → `reauthenticateWithCredential`
 * - google: `reauthenticateWithPopup`(같은 Google 계정이어야 함)
 * 끝나면 `getIdToken(true)`로 새 토큰(새 auth_time)을 받아 둔다(B3) — 바로 뒤 Callable이 그 토큰을 쓴다.
 */
export type ReauthMethod =
  | { kind: "member"; password: string }
  | { kind: "owner"; password: string }
  | { kind: "google" };

export async function reauthenticateRecent(method: ReauthMethod): Promise<void> {
  const auth = getFirebaseAuth();
  const u = auth.currentUser;
  if (!u) throw new Error("로그인이 필요합니다.");
  if (method.kind === "member") {
    await reauthenticateMemberWithPassword(method.password);
  } else if (method.kind === "owner") {
    if (!u.email) throw new Error("비밀번호로 확인할 수 없는 계정입니다.");
    await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, method.password));
  } else {
    await reauthenticateWithPopup(u, new GoogleAuthProvider());
  }
  await auth.currentUser!.getIdToken(true);
}

/** 재확인 실패 문구 — 로그인 ID 비밀번호 틀림·잠금은 서버 문구 그대로 */
export function reauthErrorMessage(e: unknown): string {
  if (e instanceof FirebaseError) {
    if (e.code.startsWith("functions/")) return e.message || WITHDRAWAL_TEXT.wrongPassword;
    if (e.code === "auth/wrong-password" || e.code === "auth/invalid-credential") return WITHDRAWAL_TEXT.wrongPassword;
    if (e.code === "auth/user-mismatch") return WITHDRAWAL_TEXT.googleMismatch;
    if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return WITHDRAWAL_TEXT.popupClosed;
    if (e.code === "auth/too-many-requests") return "시도가 너무 많아요. 잠시 후 다시 시도해 주세요.";
    if (e.code === "auth/network-request-failed") return "네트워크 연결을 확인해 주세요.";
  }
  return e instanceof Error && e.message ? e.message : "본인 확인에 실패했어요.";
}
