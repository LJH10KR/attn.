/**
 * Auth 에뮬레이터(기본 127.0.0.1:9099)에서 사용자를 만들거나 찾은 뒤
 * Custom Claim { admin: true } 를 부여합니다.
 *
 * 사전 조건: `firebase emulators:start` 로 Auth 에뮬레이터가 떠 있어야 합니다.
 *
 * 사용 (yarn):
 *   cd functions
 *   yarn grant-admin-emulator admin@local.test
 *   yarn grant-admin-emulator admin@local.test MySecret123!
 */

import admin from "firebase-admin";

const projectId =
  process.env.GCLOUD_PROJECT ||
  process.env.FIREBASE_PROJECT_ID ||
  "attndot";

if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
}

admin.initializeApp({projectId});

async function main() {
  const email = process.argv[2];
  const password = process.argv[3] || "AdminDev123!";

  if (!email) {
    console.error(
      "Usage: yarn grant-admin-emulator <email> [password]  (from functions/)",
    );
    process.exit(1);
  }

  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
    console.log("기존 사용자 uid:", user.uid);
  } catch (e) {
    if (e.code === "auth/user-not-found") {
      user = await admin.auth().createUser({
        email,
        password,
        emailVerified: true,
      });
      console.log("새 사용자 생성 uid:", user.uid);
    } else {
      throw e;
    }
  }

  await admin.auth().setCustomUserClaims(user.uid, {admin: true});
  console.log("Custom claim admin:true 적용 완료:", email);
  console.log(
    "클라이언트에서는 ID 토큰 갱신(로그아웃 후 재로그인 또는 getIdToken(true)) 후 규칙이 반영됩니다.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
