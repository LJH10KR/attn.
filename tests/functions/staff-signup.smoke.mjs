/**
 * 공용 직원 가입 링크·미리 등록·합쳐 승인(2-K) 통합 스모크 — `npm run test:functions`
 * (예전 staff-invites.smoke.mjs를 대신함: 직접 만들어 주기·권한 상승 차단·폐지된 포털 토큰도 여기서)
 * - 공용 링크 가입 = 승인 대기·기본 역할·번호 저장, 번호가 미리 등록과 같아도 자동으로 합치거나 활성하지 않음
 * - [이 직원으로 승인] = 인사 정보·역할을 합치고 활성, 번호 다름·좁은 권한 승인자 거부
 * - 미리 등록 역할 부여 권한 검사, Google 가입(원장 계정·이미 가입 거부)
 */
import assert from "node:assert/strict";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  GoogleAuthProvider,
  signInWithCredential,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { CONSENTS } from "./_signup-token.mjs";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A = "o2_a1";

const owner = await adminAuth().createUser({ email: "owner2@t.dev", password: "pass1234", emailVerified: true });
const members = await adminAuth().createUser({ email: "members@t.dev", password: "pass1234" });
await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "가입 학원", status: "active" });
await db.doc(`academies/${A}/staff/${members.uid}`).set({
  authUid: members.uid, displayName: "멤버 관리 직원", status: "active", roleId: "custom",
  permissions: ["settings.members", "operations.students"],
});

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);
const asOwner = async () => {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, "owner2@t.dev", "pass1234");
};
const asGoogle = async (sub, email) => {
  await signOut(auth);
  const cred = GoogleAuthProvider.credential(JSON.stringify({ sub, email, email_verified: true }));
  return (await signInWithCredential(auth, cred)).user;
};
const staffByLogin = async (loginId) =>
  (await db.collection(`academies/${A}/staff`).where("loginId", "==", loginId).get()).docs[0];

// --- 원장: 권한 템플릿 보장, 직원 가입 링크, 미리 등록 2명(같은 번호 1명은 퇴사 → 후보 아님) ---
await asOwner();
const { roles } = await call("listAcademyRoles", { academyId: A });
assert.ok(roles.some((r) => r.id === "lessonManager"));
const { token } = await call("getSignupLink", { academyId: A, kind: "staff" });
const hr = await call("saveStaffMember", {
  academyId: A, displayName: "미리 선생", phone: "010-4000-1111", hireDate: "2026-03-02",
  employmentStatus: "employed", memo: "수학 담당",
});
await call("setStaffSignupRole", { academyId: A, staffId: hr.staffId, roleId: "lessonManager" });
const hrRef = db.doc(`academies/${A}/staff/${hr.staffId}`);
assert.equal((await hrRef.get()).get("signupRoleId"), "lessonManager");
const resigned = await call("saveStaffMember", {
  academyId: A, displayName: "퇴사 선생", phone: "010-4000-1111", employmentStatus: "resigned",
});
await assert.rejects(
  call("setStaffSignupRole", { academyId: A, staffId: resigned.staffId, roleId: "teacher" }),
  /퇴사/,
);
// 해제도 됨
const tmp = await call("saveStaffMember", { academyId: A, displayName: "임시", employmentStatus: "employed" });
await call("setStaffSignupRole", { academyId: A, staffId: tmp.staffId, roleId: "teacher" });
await call("setStaffSignupRole", { academyId: A, staffId: tmp.staffId, roleId: null });
assert.equal((await db.doc(`academies/${A}/staff/${tmp.staffId}`).get()).get("signupRoleId"), undefined);
// 퇴사로 바꾸면 미리 등록이 지워짐
await call("setStaffSignupRole", { academyId: A, staffId: tmp.staffId, roleId: "teacher" });
await call("saveStaffMember", { academyId: A, staffId: tmp.staffId, displayName: "임시", employmentStatus: "resigned" });
assert.equal((await db.doc(`academies/${A}/staff/${tmp.staffId}`).get()).get("signupRoleId"), undefined);
await signOut(auth);

// --- 가입하는 사람(로그인 안 함): 정보 → 로그인 ID 확인 → 가입(같은 번호) ---
const info = await call("getStaffSignupInfo", { token });
assert.equal(info.academyName, "가입 학원");
await call("checkStaffSignupLoginId", { token, loginId: "matchuser" });
await assert.rejects(
  call("registerStaffSignup", { consents: CONSENTS, token, method: "password", displayName: "", phone: "010-4000-1111", loginId: "x1234", password: "secret12" }),
  /이름/,
);
await assert.rejects(
  call("registerStaffSignup", { consents: CONSENTS, token, method: "password", displayName: "번호 없음", loginId: "x1235", password: "secret12" }),
  /전화번호/,
);
const accepted = await call("registerStaffSignup", { consents: CONSENTS,
  token, method: "password", displayName: "가입한 이름", phone: "01040001111", loginId: "matchuser", password: "secret12",
});
assert.equal(accepted.membershipStatus, "pending_registration");
const joined = await staffByLogin("matchuser");
assert.equal(joined.get("status"), "pending_registration");
assert.equal(joined.get("roleId"), "teacher", "가입은 항상 기본 역할");
assert.deepEqual(joined.get("permissions"), []);
assert.equal(joined.get("phone"), "010-4000-1111");
assert.equal(joined.get("signupSource"), "staff_link");
// 번호가 같아도 자동으로 합치거나 활성하지 않음
assert.equal((await hrRef.get()).exists, true, "미리 등록한 인사 문서 그대로");
assert.equal((await hrRef.get()).get("status"), "no_account");
await assert.rejects(call("checkStaffSignupLoginId", { token, loginId: "matchuser" }), /이미 사용 중/);

// 승인 전 로그인 → 승인 대기, 스스로 활성화 불가
const signedIn = await call("signInTeacher", { loginId: "matchuser", password: "secret12" });
assert.equal(signedIn.membershipStatus, "pending_registration");
await signInWithCustomToken(auth, signedIn.customToken);
await assert.rejects(call("listAcademyRoles", { academyId: A }), /권한/, "승인 전에는 권한 없음");
await assert.rejects(
  call("approveStaffSignupAsExisting", { academyId: A, staffAuthUid: joined.id, hrStaffId: hr.staffId }),
  /권한/,
);
await signOut(auth);

// 번호가 다른 가입자
await call("registerStaffSignup", { consents: CONSENTS,
  token, method: "password", displayName: "다른 번호", phone: "010-4000-2222", loginId: "otheruser", password: "secret12",
});
const other = await staffByLogin("otheruser");

// --- 멤버 관리 직원(좁은 권한): 넓은 역할 미리 등록·합쳐 승인 불가 ---
await signInWithEmailAndPassword(auth, "members@t.dev", "pass1234");
await assert.rejects(
  call("setStaffSignupRole", { academyId: A, staffId: hr.staffId, roleId: "superAdmin" }),
  /본인이 가진 권한까지만/,
);
await assert.rejects(
  call("approveStaffSignupAsExisting", { academyId: A, staffAuthUid: joined.id, hrStaffId: hr.staffId }),
  /본인이 가진 권한까지만/,
  "미리 등록 역할(수업관리)이 승인자 권한을 넘음",
);
await assert.rejects(
  call("createStaffAccounts", { academyId: A, items: [{ displayName: "y", roleId: "admin" }] }),
  /본인이 가진 권한까지만/,
);
await signOut(auth);

// --- 원장: 번호 다른 계정으로는 합칠 수 없음 → 이 직원으로 승인(합침) / 새 직원으로 승인 ---
await asOwner();
await assert.rejects(
  call("approveStaffSignupAsExisting", { academyId: A, staffAuthUid: other.id, hrStaffId: hr.staffId }),
  /미리 등록한 직원 정보가 바뀌었습니다/,
);
await assert.rejects(
  call("approveStaffSignupAsExisting", { academyId: A, staffAuthUid: joined.id, hrStaffId: resigned.staffId }),
  /미리 등록한 직원 정보가 바뀌었습니다/,
  "퇴사 직원은 후보 아님",
);
await call("approveStaffSignupAsExisting", { academyId: A, staffAuthUid: joined.id, hrStaffId: hr.staffId });
const merged = await joined.ref.get();
assert.equal(merged.get("status"), "active");
assert.equal(merged.get("roleId"), "lessonManager");
assert.ok(merged.get("permissions").includes("lessons.attendance"));
assert.equal(merged.get("displayName"), "미리 선생", "인사 정보 이름");
assert.equal(merged.get("hireDate"), "2026-03-02");
assert.equal(merged.get("memo"), "수학 담당");
assert.equal(merged.get("mergedFromStaffId"), hr.staffId);
assert.equal((await hrRef.get()).exists, false, "인사 문서는 합쳐지고 삭제");
assert.equal((await adminAuth().getUser(joined.id)).customClaims?.membershipStatus, "active");
await assert.rejects(
  call("approveStaffSignupAsExisting", { academyId: A, staffAuthUid: joined.id, hrStaffId: resigned.staffId }),
  /가입 승인 대기 중인 계정만/,
);
await call("activateTeacher", { academyId: A, teacherAuthUid: other.id });
const otherActive = await other.ref.get();
assert.equal(otherActive.get("status"), "active");
assert.equal(otherActive.get("roleId"), "teacher", "새 직원으로 승인 = 기본 역할");

// --- 직접 만들어 주기(그대로) ---
const hr2 = await call("saveStaffMember", { academyId: A, displayName: "직접 만든 직원", employmentStatus: "employed" });
const { accounts } = await call("createStaffAccounts", { academyId: A, items: [{ staffId: hr2.staffId, roleId: "teacher" }] });
assert.equal(accounts.length, 1);
assert.ok(accounts[0].loginId && accounts[0].tempPassword);
const created = await db.doc(`academies/${A}/staff/${accounts[0].authUid}`).get();
assert.equal(created.get("status"), "pending_setup");
assert.equal(created.get("displayName"), "직접 만든 직원");
await signOut(auth);
assert.equal(
  (await call("signInTeacher", { loginId: accounts[0].loginId, password: accounts[0].tempPassword })).membershipStatus,
  "pending_setup",
);

// --- Google 가입: 승인 대기 / 이미 가입 거부 / 원장 계정 거부 ---
const g = await asGoogle("google-staff-1", "gstaff1@gmail.com");
await call("registerStaffSignup", { consents: CONSENTS, token, method: "google", displayName: "구글 직원", phone: "010-4000-3333" });
const gDoc = await db.doc(`academies/${A}/staff/${g.uid}`).get();
assert.equal(gDoc.get("status"), "pending_registration");
assert.equal(gDoc.get("authProvider"), "google");
assert.equal(gDoc.get("phone"), "010-4000-3333");
await assert.rejects(
  call("registerStaffSignup", { consents: CONSENTS, token, method: "google", displayName: "구글 직원", phone: "010-4000-3333" }),
  /이미 이 학원에 가입된 계정/,
);
const gOwner = await asGoogle("google-owner-1", "gowner1@gmail.com");
await db.doc(`users/${gOwner.uid}`).set({ platformRole: "owner" });
await assert.rejects(
  call("registerStaffSignup", { consents: CONSENTS, token, method: "google", displayName: "원장", phone: "010-4000-4444" }),
  /원장 계정으로는/,
);
await signOut(auth);

// --- 폐지된 학원 포털 토큰(role=academy)은 권한 없음 ---
const portalToken = await adminAuth().createCustomToken(`academy_${A}`, { role: "academy", academyId: A });
await signInWithCustomToken(auth, portalToken);
await assert.rejects(call("listAcademyRoles", { academyId: A }), /권한/);
await assert.rejects(call("getSignupLink", { academyId: A, kind: "staff" }), /권한/);

console.log("SMOKE OK (staff signup)");
process.exit(0);
