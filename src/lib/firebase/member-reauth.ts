"use client";

import { signInWithCustomToken, type User } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";

/**
 * 선생님·학부모 본인 재확인(Google 연결처럼 최근 로그인이 필요한 작업 전).
 * 로그인 ID 계정의 Auth 비밀번호는 무작위라 `reauthenticateWithCredential`을 쓸 수 없으므로,
 * 서버(`reauthenticateMember`)가 로그인 ID 비밀번호를 확인(연속 실패 잠금 포함)하고 준 토큰으로 다시 로그인한다.
 * 실패하면 Functions 오류(`functions/permission-denied`·`functions/resource-exhausted`, 메시지는 서버 문구)를 그대로 던진다.
 */
export async function reauthenticateMemberWithPassword(password: string): Promise<User> {
  const res = await httpsCallable(getFirebaseFunctions(), "reauthenticateMember")({ password });
  const { customToken } = res.data as { customToken: string };
  const cred = await signInWithCustomToken(getFirebaseAuth(), customToken);
  return cred.user;
}
