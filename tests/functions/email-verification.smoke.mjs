/**
 * 원장 이메일 인증(3-A 후속 [Fix]) 통합 스모크 — `npm run test:functions`(SMTP 없음 → 에뮬레이터는 로그·debugCode).
 * - F2 `confirmGoogleEmailVerified`: Google + 같은 이메일 → 인증(users 문서는 서버가 쓰지 않음),
 *   다른 사람 이메일 비밀번호 계정 + 내 Google(다른 이메일)·Google 없음·내부 이메일 → 그대로, 이미 인증 → true, 로그인 없음 거부.
 * - F1 `issueEmailVerificationOtp` mode: auto는 최근 보낸 유효 코드가 있으면 건너뜀(그 코드로 인증 성공),
 *   10분 지난 코드면 새로 보냄, 시도 소진 60초 안 = cooldown, resend 60초 제한, 보내지 못한 코드(deliveredAt 없음)는
 *   recent·cooldown이 되지 않음(B1), alreadyVerified, 잘못된 mode 거부.
 */
import assert from "node:assert/strict";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb, Timestamp } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  GoogleAuthProvider,
  linkWithCredential,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);
const MIN = 60 * 1000;

async function rejectsCode(p, code, label) {
  await assert.rejects(p, (e) => e?.code === code, label);
}

/** 비밀번호 계정 만들고 로그인 — 필요하면 Google 연결 후 운영 fDaS처럼 emailVerified=false로 되돌림 */
async function ownerAccount(email, googleEmail, sub) {
  const u = await adminAuth().createUser({ email, password: "pass1234", emailVerified: false });
  await signOut(auth);
  await signInWithEmailAndPassword(auth, email, "pass1234");
  if (googleEmail) {
    await linkWithCredential(
      auth.currentUser,
      GoogleAuthProvider.credential(JSON.stringify({ sub, email: googleEmail, email_verified: true })),
    );
    await adminAuth().updateUser(u.uid, { emailVerified: false });
    const rec = await adminAuth().getUser(u.uid);
    assert.ok(rec.providerData.some((p) => p.providerId === "google.com"), "google.com 연결됨");
    assert.equal(rec.emailVerified, false);
  }
  return u;
}

// ===== F2 =====
await signOut(auth);
await rejectsCode(call("confirmGoogleEmailVerified", {}), "functions/unauthenticated", "로그인 없음 거부");

// Google + 같은 이메일(대소문자 다름) → 인증
const same = await ownerAccount("same81@t.dev", "Same81@T.dev", "g-same81");
assert.deepEqual(await call("confirmGoogleEmailVerified", {}), { verified: true });
assert.equal((await adminAuth().getUser(same.uid)).emailVerified, true, "Auth emailVerified true");
assert.equal((await db.doc(`users/${same.uid}`).get()).exists, false, "users 문서는 서버가 쓰지 않음");
assert.deepEqual(await call("confirmGoogleEmailVerified", {}), { verified: true }, "이미 인증 → true");

// 다른 사람 이메일로 만든 비밀번호 계정 + 내 Google(다른 이메일) → 그대로
const victim = await ownerAccount("victim81@t.dev", "attacker81@gmail.com", "g-attacker81");
assert.deepEqual(await call("confirmGoogleEmailVerified", {}), { verified: false });
assert.equal((await adminAuth().getUser(victim.uid)).emailVerified, false, "다른 Google 이메일이면 미인증 유지");

// Google 없음 → 그대로
const plain = await ownerAccount("plain81@t.dev");
assert.deepEqual(await call("confirmGoogleEmailVerified", {}), { verified: false });
assert.equal((await adminAuth().getUser(plain.uid)).emailVerified, false);

// 내부 이메일(로그인 ID 계정) → Google 이메일이 같아도 그대로
const internalEmail = "t81_x@provision.attndot.internal";
const internal = await ownerAccount(internalEmail, internalEmail, "g-internal81");
assert.deepEqual(await call("confirmGoogleEmailVerified", {}), { verified: false });
assert.equal((await adminAuth().getUser(internal.uid)).emailVerified, false, "내부 이메일 제외");

// ===== F1 =====
// 잘못된 mode 거부
await signInWithEmailAndPassword(auth, "plain81@t.dev", "pass1234");
await rejectsCode(call("issueEmailVerificationOtp", { purpose: "owner", mode: "x" }), "functions/invalid-argument", "mode 검사");

// 가입 직후 발송(resend) → 창이 열리며 auto → recent(코드 그대로) → 그 코드로 인증 성공
const first = await call("issueEmailVerificationOtp", { purpose: "owner", mode: "resend" });
assert.equal(first.sent, true);
assert.match(first.debugCode, /^\d{6}$/);
const otpRef = db.doc(`emailVerificationOtps/${plain.uid}`);
assert.ok((await otpRef.get()).get("deliveredAt"), "보내기 성공 뒤 deliveredAt");
assert.deepEqual(await call("issueEmailVerificationOtp", { purpose: "owner", mode: "auto" }), {
  ok: true,
  sent: false,
  reason: "recent",
});
// mode 없음 = resend(가입 직후 호출 호환) → 60초 제한
await rejectsCode(call("issueEmailVerificationOtp", { purpose: "owner" }), "functions/resource-exhausted", "resend 60초 제한");
await call("verifyEmailVerificationOtp", { purpose: "owner", code: first.debugCode });
assert.equal((await adminAuth().getUser(plain.uid)).emailVerified, true, "최근 코드로 인증 성공");
// 이미 인증 → alreadyVerified
assert.deepEqual(await call("issueEmailVerificationOtp", { purpose: "owner", mode: "auto" }), {
  ok: true,
  alreadyVerified: true,
});

// 10분 지난 코드 → auto가 새로 보냄(앞 코드 무효)
const late = await ownerAccount("late81@t.dev");
const lateRef = db.doc(`emailVerificationOtps/${late.uid}`);
const old = await call("issueEmailVerificationOtp", { purpose: "owner", mode: "auto" });
assert.equal(old.sent, true, "코드 없으면 auto가 보냄");
await lateRef.update({
  deliveredAt: Timestamp.fromMillis(Date.now() - 11 * MIN),
  expiresAt: Timestamp.fromMillis(Date.now() + 4 * MIN),
});
const fresh = await call("issueEmailVerificationOtp", { purpose: "owner", mode: "auto" });
assert.equal(fresh.sent, true, "10분 지나면 새로 보냄");
if (fresh.debugCode !== old.debugCode) {
  await rejectsCode(
    call("verifyEmailVerificationOtp", { purpose: "owner", code: old.debugCode }),
    "functions/permission-denied",
    "앞 코드 무효",
  );
}

// 시도 소진 + 60초 안 → auto cooldown
await lateRef.update({ attempts: 5, deliveredAt: Timestamp.fromMillis(Date.now() - 10_000) });
assert.deepEqual(await call("issueEmailVerificationOtp", { purpose: "owner", mode: "auto" }), {
  ok: true,
  sent: false,
  reason: "cooldown",
});

// B1 — 보내지 못한 코드(deliveredAt 없음, 방금 저장)는 recent·cooldown이 아님 → auto도 resend도 바로 보냄
await lateRef.set({
  codeHash: "x",
  email: "late81@t.dev",
  purpose: "owner",
  attempts: 0,
  lastSentAt: Timestamp.now(),
  expiresAt: Timestamp.fromMillis(Date.now() + 15 * MIN),
});
assert.equal((await call("issueEmailVerificationOtp", { purpose: "owner", mode: "auto" })).sent, true, "보내지 못한 코드 → auto 발송");
await lateRef.update({ deliveredAt: null });
assert.equal((await call("issueEmailVerificationOtp", { purpose: "owner", mode: "resend" })).sent, true, "보내지 못한 코드 → resend 제한 없음");

await signOut(auth);
console.log("SMOKE OK (email verification)");
process.exit(0);
