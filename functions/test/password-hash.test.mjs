/**
 * 로그인 비밀번호 해시(`src/lib/password-hash.ts`) 단위 테스트 — `npm test` (빌드 후 lib/ 대상)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasLoginSecret,
  hashPassword,
  passwordSecretFields,
  tempPasswordSecretFields,
  verifyLoginSecret,
  verifyPassword,
} from "../lib/lib/password-hash.js";

describe("hashPassword / verifyPassword", () => {
  it("같은 비밀번호는 통과, 다른 비밀번호는 실패", async () => {
    const record = await hashPassword("secret12");
    assert.equal(await verifyPassword("secret12", record), true);
    assert.equal(await verifyPassword("secret13", record), false);
    assert.equal(await verifyPassword("", record), false);
  });

  it("평문을 담지 않고, 솔트와 파라미터를 함께 저장하며, 매번 솔트가 다르다", async () => {
    const a = await hashPassword("secret12");
    const b = await hashPassword("secret12");
    assert.equal(JSON.stringify(a).includes("secret12"), false);
    assert.equal(a.algo, "scrypt");
    assert.ok(a.N > 0 && a.r > 0 && a.p > 0 && a.keyLen > 0);
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.hash, b.hash);
  });

  it("저장된 파라미터로 검증하므로 기본값이 바뀌어도 예전 해시가 통과한다", async () => {
    const record = await hashPassword("secret12");
    // 다른 비용으로 만든 기록을 흉내: 같은 비밀번호를 N=1024로 다시 해시하면 검증도 N=1024로
    const crypto = await import("node:crypto");
    const salt = Buffer.from(record.salt, "base64");
    const key = crypto.scryptSync("secret12", salt, 64, { N: 1024, r: 8, p: 1 });
    const legacy = { ...record, N: 1024, hash: key.toString("base64") };
    assert.equal(await verifyPassword("secret12", legacy), true);
  });

  it("형식이 깨지거나 조작된 기록은 실패(예외 없이)", async () => {
    const record = await hashPassword("secret12");
    for (const bad of [
      null,
      "secret12",
      { ...record, algo: "md5" },
      { ...record, N: 1000 },
      { ...record, N: 1 << 24 },
      { ...record, keyLen: 4 },
      { ...record, hash: "" },
      { ...record, salt: 3 },
    ]) {
      assert.equal(await verifyPassword("secret12", bad), false);
    }
  });
});

describe("secrets/login 필드", () => {
  it("본인 비밀번호·임시 비밀번호 중 하나와 맞으면 로그인 통과", async () => {
    const own = await passwordSecretFields("mine1234");
    const temp = await tempPasswordSecretFields("temp1234");
    assert.equal(await verifyLoginSecret({ passwordHash: own.passwordHash }, "mine1234"), true);
    assert.equal(await verifyLoginSecret({ tempPasswordHash: temp.tempPasswordHash }, "temp1234"), true);
    assert.equal(await verifyLoginSecret({ tempPasswordHash: temp.tempPasswordHash }, "mine1234"), false);
    assert.equal(await verifyLoginSecret(undefined, "mine1234"), false);
  });

  it("예전 평문 필드는 더 이상 인정하지 않는다", async () => {
    assert.equal(await verifyLoginSecret({ password: "plain123", tempPassword: "plain123" }, "plain123"), false);
    assert.equal(hasLoginSecret({ password: "plain123" }), false);
  });

  it("저장 필드에 평문이 없고, 본인 비밀번호 저장 시 임시 비밀번호는 지운다", async () => {
    const own = await passwordSecretFields("mine1234");
    const temp = await tempPasswordSecretFields("temp1234");
    assert.equal(JSON.stringify(own.passwordHash).includes("mine1234"), false);
    assert.equal(JSON.stringify(temp.tempPasswordHash).includes("temp1234"), false);
    assert.ok("tempPasswordHash" in own, "첫 로그인·변경 시 임시 비밀번호 해시 삭제");
    assert.ok("passwordHash" in temp, "재발급 시 이전 비밀번호 해시 삭제");
    assert.equal(hasLoginSecret({ passwordHash: own.passwordHash }), true);
  });
});
