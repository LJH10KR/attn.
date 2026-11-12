/**
 * 본인 회원 탈퇴(2-N N1~N5) — 순수 판단. 서버 함수는 `account-withdrawal.ts`.
 */

export type WithdrawalBlock = "admin" | "owns_academies" | null;

/** 관리자 계정·소유 학원이 있는 원장은 탈퇴할 수 없음(N5) */
export function withdrawalBlock(isAdmin: boolean, ownedAcademyCount: number): WithdrawalBlock {
  if (isAdmin) return "admin";
  if (ownedAcademyCount > 0) return "owns_academies";
  return null;
}

export const WITHDRAWAL_BLOCK_MESSAGE: Record<Exclude<WithdrawalBlock, null>, string> = {
  admin: "관리자 계정은 탈퇴할 수 없어요.",
  owns_academies: "운영 중인 학원이 있어 탈퇴할 수 없어요. 학원을 먼저 삭제해 주세요.",
};

/** 원장 벨 문서 ID — 역할마다 하나(같은 학원에 학부모·직원 둘 다였을 수 있음), 재시도에도 한 번만 */
export function withdrawnBellId(role: "parent" | "teacher", uid: string): string {
  return `withdrawn-${role}-${uid}`;
}

/** 탈퇴가 같은 처리를 다시 돌 때의 최대 횟수(소속 조회 한 번에 50개씩) */
export const WITHDRAWAL_MAX_ROUNDS = 10;
