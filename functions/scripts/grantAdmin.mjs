/**
 * 운영 환경용 — Auth 사용자에게 Custom Claim { admin: true } 를 부여합니다.
 *
 * 사전 준비(중요):
 * - Firebase Admin SDK는 Service Account 권한이 필요합니다.
 * - 아래 중 하나로 자격 증명을 제공해 주세요.
 *   1) GOOGLE_APPLICATION_CREDENTIALS 환경변수로 Service Account JSON 경로 지정
 *   2) 코드에 service account 파일을 직접 경로로 지정
 *   3) (권장) .env.production에서 SERVICE_ACCOUNT_KEY_BASE64 로 Service Account JSON을 Base64로 전달
 *
 * 사용:
 *   node scripts/grantAdmin.mjs <email>
 *
 * 예:
 *   node scripts/grantAdmin.mjs leeojuhan10@gmail.com
 */
import admin from "firebase-admin";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    const out = {};
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // 양끝 따옴표 제거 (예: "xxx" / 'xxx')
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function loadRootEnvProductionOnce() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url)); // functions/scripts
  const rootDir = path.resolve(scriptDir, "..", "..");
  const envPath = path.join(rootDir, ".env.production");
  const values = parseEnvFile(envPath);
  for (const [k, v] of Object.entries(values)) {
    if (process.env[k] == null && typeof v === "string" && v.length > 0) {
      process.env[k] = v;
    }
  }
}

loadRootEnvProductionOnce();

const projectId =
  process.env.GCLOUD_PROJECT ||
  process.env.FIREBASE_PROJECT_ID ||
  "attndot";

function initCredential() {
  const base64 = process.env.SERVICE_ACCOUNT_KEY_BASE64;
  if (base64) {
    const json = JSON.parse(
      Buffer.from(base64, "base64").toString("utf8"),
    );
    const resolvedProjectId =
      json.project_id || json.projectId || projectId;
    // Firebase Admin SDK credential
    const credential = admin.credential.cert(json);
    return { credential, projectId: resolvedProjectId };
  }

  // 파일 경로 방식: GOOGLE_APPLICATION_CREDENTIALS가 설정되어 있으면 기본 적용
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return { credential: admin.credential.applicationDefault(), projectId };
  }

  return { credential: undefined, projectId };
}

if (!admin.apps.length) {
  const { credential, projectId: resolvedProjectId } = initCredential();
  admin.initializeApp({ projectId: resolvedProjectId, ...(credential ? { credential } : {}) });
}

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: node scripts/grantAdmin.mjs <email>");
    process.exit(1);
  }

  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
  } catch (e) {
    // 사용자 생성은 의도치 않은 계정 생성 리스크가 있어 기본적으로 막습니다.
    console.error(
      "해당 이메일의 Auth 사용자를 찾지 못했습니다. 먼저 Firebase Console에서 사용자를 생성해 주세요.\n",
      e,
    );
    process.exit(1);
  }

  await admin.auth().setCustomUserClaims(user.uid, { admin: true });
  console.log("Custom claim admin:true 적용 완료:", email, "uid:", user.uid);
  console.log(
    "클라이언트 반영을 위해, 해당 사용자는 로그아웃 후 재로그인(또는 ID 토큰 강제 갱신)이 필요합니다.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

