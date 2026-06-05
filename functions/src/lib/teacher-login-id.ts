import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { assertMemberLoginIdAvailable } from "./member-login-id";

/** 크몽 스타일 — 형용사+명사 (띄어쓰기 없음) */
const ADJECTIVES = [
  "용감한",
  "소심한",
  "활발한",
  "조용한",
  "친절한",
  "똑똑한",
  "차분한",
  "상냥한",
  "씩씩한",
  "다정한",
  "명랑한",
  "느긋한",
  "반짝이는",
  "포근한",
  "든든한",
] as const;

const NOUNS = [
  "코끼리",
  "파인애플",
  "고양이",
  "펭귄",
  "다람쥐",
  "토끼",
  "돌고래",
  "판다",
  "사자",
  "호랑이",
  "강아지",
  "햄스터",
  "부엉이",
  "여우",
  "너구리",
  "수박",
  "당근",
  "별똥별",
] as const;

function pick<T>(arr: readonly T[]): T {
  return arr[crypto.randomInt(0, arr.length)]!;
}

function candidateTeacherLoginId(): string {
  const adj = pick(ADJECTIVES);
  const noun = pick(NOUNS);
  const id = `${adj}${noun}`;
  return id.length <= 12 ? id : id.slice(0, 12);
}

/** 크몽·마켓플레이스 스타일 한글 닉네임 — 전역 유일 보장 */
export async function allocateTeacherLoginId(
  db: admin.firestore.Firestore,
): Promise<string> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const raw = candidateTeacherLoginId();
    try {
      return await assertMemberLoginIdAvailable(db, raw);
    } catch (e) {
      if (e instanceof HttpsError && e.code === "already-exists") {
        continue;
      }
      throw e;
    }
  }
  throw new HttpsError(
    "resource-exhausted",
    "로그인 ID를 자동 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  );
}
