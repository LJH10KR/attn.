import type { User } from "firebase/auth";

const GOOGLE_PROVIDER_ID = "google.com";

/**
 * Google 소셜 로그인(또는 계정 연동)이 있는 경우에만, 해당 provider가 제공하는 프로필 사진 URL을 반환합니다.
 * 이메일/비밀번호만 쓰는 계정은 null이 되어 이니셜 아바타를 쓰게 됩니다.
 */
export function profilePhotoUrlForUser(user: User): string | null {
  const google = user.providerData.find((p) => p.providerId === GOOGLE_PROVIDER_ID);
  if (!google) return null;
  const url = google.photoURL?.trim();
  return url || null;
}
