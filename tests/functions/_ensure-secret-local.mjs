/**
 * 에뮬레이터용 가짜 Secret(2-L) — `functions/.secret.local`이 없으면 만든다(`functions/.gitignore`의 `*.local`로 커밋되지 않음).
 * 이 파일이 없으면 Functions 에뮬레이터가 Secret Manager에서 `OCTOMO_API_KEY`를 읽으려 한다:
 * demo 프로젝트는 403 오류 로그만 남고, 실제 프로젝트(attndot)로 띄우면 로그인한 계정 권한으로 **실제 키를 가져온다**.
 * 에뮬레이터의 OCTOMO는 항상 가짜 모드라 키를 쓰지 않으므로, 실제 키가 로컬로 오지 않게 가짜 값을 둔다.
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const file = resolve(dirname(fileURLToPath(import.meta.url)), "../../functions/.secret.local");
if (!existsSync(file)) {
  writeFileSync(file, "OCTOMO_API_KEY=emulator-fake-not-used\n");
  console.log("functions/.secret.local 만듦(가짜 값)");
}
