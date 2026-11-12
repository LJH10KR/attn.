/**
 * 직원 여러 명 미리 등록 표(2-M, `createStaffPreRegistrations`) 통합 스모크 — `npm run test:functions`.
 * 계정 없는 직원 + signupRoleId, 권한 나뉨(settings.staff만 → 권한 칸 거부, 좁은 멤버 관리 → 넘는 역할 거부),
 * 번호 검사(형식·표 안 중복·기존 미리 등록/계정과 같음 → 경고 후 확인), 표로 등록 → 직원 가입 + 문자 확인 → 바로 활성.
 */
import assert from "node:assert/strict";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { CONSENTS, seedSignupToken } from "./_signup-token.mjs";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A = "o21_a1";

for (const d of (await db.collection("phoneVerificationCounters").get()).docs) {
  if (d.id.startsWith("ip_hr_")) await d.ref.delete();
}

const owner = await adminAuth().createUser({ email: "owner21@t.dev", password: "pass1234", emailVerified: true });
const staffOnly = await adminAuth().createUser({ email: "hr21@t.dev", password: "pass1234" });
const narrow = await adminAuth().createUser({ email: "narrow21@t.dev", password: "pass1234" });
await adminAuth().createUser({ email: "nobody21@t.dev", password: "pass1234" });
await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "직원 표 학원", status: "active" });
await db.doc(`academies/${A}/meta/seq`).set({ nextTeacherSeq: 1, nextParentSeq: 1, nextStudentSeq: 1 });
await db.doc(`academies/${A}/staff/${staffOnly.uid}`).set({
  authUid: staffOnly.uid, displayName: "인사 담당", status: "active", roleId: "x", permissions: ["settings.staff"],
  isGuest: false, phone: "010-5100-9001",
});
await db.doc(`academies/${A}/staff/${narrow.uid}`).set({
  authUid: narrow.uid, displayName: "좁은 관리", status: "active", roleId: "y",
  permissions: ["settings.staff", "settings.members", "operations.students"], isGuest: false,
});
await db.doc(`academies/${A}/roles/narrowRole`).set({ name: "원생만", permissions: ["operations.students"] });
const S = await seedSignupToken(db, A, "staff");

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);
const as = async (email) => {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, email, "pass1234");
};
const row = (rowKey, patch = {}) => ({
  rowKey, displayName: `직원-${rowKey}`, phone: "", signupRoleId: null, allowDuplicatePhone: false, ...patch,
});
const save = (rows) => call("createStaffPreRegistrations", { academyId: A, rows });
const staffDoc = async (id) => (await db.doc(`academies/${A}/staff/${id}`).get()).data();

// --- 권한·크기 ---
await as("nobody21@t.dev");
await assert.rejects(save([row("x", { phone: "010-5100-0001" })]), /권한/);
await as("owner21@t.dev");
const { roles } = await call("listAcademyRoles", { academyId: A });
assert.ok(roles.some((r) => r.id === "lessonManager"));
await assert.rejects(save(Array.from({ length: 51 }, (_, i) => row(`r${i}`, { phone: `010-5101-${1000 + i}` }))), /50명까지/);

// --- 원장: 성공·검사 ---
const r1 = await save([
  row("withRole", { displayName: "김수업", phone: "01051000001", signupRoleId: "lessonManager" }),
  row("noRole", { displayName: "이행정", phone: "+82 10-5100-0002" }),
  row("badPhone", { phone: "02-123-4567" }),
  row("noName", { displayName: " ", phone: "010-5100-0003" }),
  row("twinA", { phone: "010-5100-0004" }),
  row("twinB", { phone: "01051000004" }),
  row("hasAccount", { phone: "010-5100-9001" }),
  row("badRole", { phone: "010-5100-0005", signupRoleId: "noSuchRole" }),
]);
const k1 = Object.fromEntries(r1.results.map((r) => [r.rowKey, r]));
assert.equal(r1.createdCount, 2);
assert.equal(k1.withRole.ok, true);
assert.equal(k1.withRole.signupRoleId, "lessonManager");
assert.equal(k1.noRole.ok, true);
assert.equal(k1.noRole.signupRoleId, null);
assert.match(k1.badPhone.message, /형식/);
assert.match(k1.noName.message, /이름/);
assert.equal(k1.twinA.code, "duplicate_in_table");
assert.equal(k1.twinB.code, "duplicate_in_table");
assert.equal(k1.hasAccount.code, "duplicate_phone");
assert.equal(k1.hasAccount.conflict, "account");
assert.equal(k1.badRole.code, "role");

const d1 = await staffDoc(k1.withRole.staffId);
assert.equal(d1.status, "no_account");
assert.equal(d1.authUid, null);
assert.equal(d1.isGuest, false);
assert.equal(d1.employmentStatus, "employed");
assert.deepEqual(d1.permissions, []);
assert.equal(d1.phone, "010-5100-0001");
assert.equal(d1.signupRoleId, "lessonManager");
assert.equal(d1.signupRoleSetByUid, owner.uid);
assert.equal(d1.phoneVerifiedKey, undefined, "확인 표시 없음");
assert.equal((await staffDoc(k1.noRole.staffId)).phone, "010-5100-0002");
assert.equal((await staffDoc(k1.noRole.staffId)).signupRoleId, undefined);

// 기존 미리 등록과 같은 번호 → 경고(pre_registered), 확인하면 저장
const r2 = await save([row("again", { phone: "010-5100-0001" })]);
assert.equal(r2.results[0].code, "duplicate_phone");
assert.equal(r2.results[0].conflict, "pre_registered");
const r3 = await save([row("again", { phone: "010-5100-0001", allowDuplicatePhone: true })]);
assert.equal(r3.results[0].ok, true);
// 계정이 있는 직원 번호도 확인하면 저장
assert.equal((await save([row("acct", { phone: "010-5100-9001", allowDuplicatePhone: true })])).results[0].ok, true);

// --- settings.staff만: 권한 칸 줄 거부, 권한 없는 줄 저장 ---
await as("hr21@t.dev");
const r4 = await save([row("h1", { phone: "010-5100-0011", signupRoleId: "lessonManager" }), row("h2", { phone: "010-5100-0012" })]);
assert.equal(r4.results[0].code, "role");
assert.match(r4.results[0].message, /멤버 관리 권한/);
assert.equal(r4.results[1].ok, true);

// --- 좁은 멤버 관리: 넘는 역할 거부, 가진 권한 안의 역할은 저장 ---
await as("narrow21@t.dev");
const r5 = await save([
  row("n1", { phone: "010-5100-0021", signupRoleId: "superAdmin" }),
  row("n2", { phone: "010-5100-0022", signupRoleId: "narrowRole" }),
]);
assert.equal(r5.results[0].code, "role");
assert.match(r5.results[0].message, /본인이 가진 권한까지만/);
assert.equal(r5.results[1].ok, true);
assert.equal((await staffDoc(r5.results[1].staffId)).signupRoleId, "narrowRole");

// --- 표로 등록 → 직원 가입 QR + 문자 확인 → 후보 1명 + 권한 → 바로 활성(2-L) ---
await as("owner21@t.dev");
const AUTO = "010-5100-0099";
const r6 = await save([row("auto", { displayName: "자동 선생", phone: AUTO, signupRoleId: "lessonManager" })]);
const hrId = r6.results[0].staffId;
await signOut(auth);
const st = await call("startPhoneVerification", { purpose: "staff_signup", token: S, phone: AUTO });
const ck = await call("checkPhoneVerification", { verificationId: st.verificationId });
assert.equal(ck.status, "verified");
const joined = await call("registerStaffSignup", {
  token: S, method: "password", displayName: "자동 선생", phone: AUTO, loginId: "bulkauto1", password: "pw123456",
  consents: CONSENTS, phoneProof: ck.proof,
});
assert.equal(joined.membershipStatus, "active", "바로 활성");
const acct = (await db.collection(`academies/${A}/staff`).where("loginId", "==", "bulkauto1").get()).docs[0];
assert.equal(acct.get("status"), "active");
assert.equal(acct.get("roleId"), "lessonManager");
assert.equal((await db.doc(`academies/${A}/staff/${hrId}`).get()).exists, false, "미리 등록 문서는 계정으로 합쳐짐");
assert.equal((await db.doc(`academies/${A}/adminInbox/s-autoact-${acct.id}`).get()).exists, true);

console.log("SMOKE OK staff-bulk");
process.exit(0);
