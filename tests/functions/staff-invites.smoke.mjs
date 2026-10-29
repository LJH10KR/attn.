/**
 * 직원 초대 Callable 통합 스모크 — `npm run test:functions` (Auth·Firestore·Functions 에뮬레이터)
 * 초대 링크 발급 → 정보 조회 → 로그인 ID 확인 → 가입(승인 대기) → 로그인 → 승인,
 * 계정 직접 만들기(임시 비밀번호 로그인), 권한 상승 차단, 폐지된 포털 토큰 거부를 확인한다.
 */
import assert from "node:assert/strict";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A = "o2_a1";

const owner = await adminAuth().createUser({ email: "owner2@t.dev", password: "pass1234", emailVerified: true });
const members = await adminAuth().createUser({ email: "members@t.dev", password: "pass1234" });
await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "초대 학원" });
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

// --- 원장: 권한 템플릿 보장 + 이름만으로 초대 링크 ---
await signInWithEmailAndPassword(auth, "owner2@t.dev", "pass1234");
const { roles } = await call("listAcademyRoles", { academyId: A });
assert.ok(roles.some((r) => r.id === "lessonManager"));
const invite = await call("createStaffInvite", { academyId: A, displayName: "초대 선생님", roleId: "lessonManager" });
const token = new URL(invite.url).searchParams.get("token");
assert.ok(token && token.length >= 32);
const hrRef = db.doc(`academies/${A}/staff/${invite.staffId}`);
assert.equal((await hrRef.get()).get("status"), "no_account");
assert.ok((await db.collection("staffInvites").get()).size === 1);
await signOut(auth);

// --- 초대받은 사람(로그인 안 함): 정보 확인 → ID 확인 → 가입 ---
const info = await call("getStaffInviteInfo", { token });
assert.equal(info.displayName, "초대 선생님");
assert.equal(info.roleName, "수업관리");
await call("checkStaffInviteLoginId", { token, loginId: "inviteduser" });
await assert.rejects(call("checkStaffInviteLoginId", { token: "x".repeat(43), loginId: "inviteduser" }), /사용했거나|취소/);
const accepted = await call("acceptStaffInvite", { token, method: "password", loginId: "inviteduser", password: "secret12" });
assert.equal(accepted.membershipStatus, "pending_registration");
assert.equal((await hrRef.get()).exists, false, "인사 문서는 계정 문서로 옮겨짐");
const joined = (await db.collection(`academies/${A}/staff`).where("loginId", "==", "inviteduser").get()).docs[0];
assert.equal(joined.get("status"), "pending_registration");
assert.equal(joined.get("roleId"), "lessonManager");
assert.ok(joined.get("permissions").includes("lessons.attendance"));
assert.equal((await db.collection("staffInvites").get()).size, 0);
await assert.rejects(
  call("acceptStaffInvite", { token, method: "password", loginId: "another1", password: "secret12" }),
  /사용했거나|취소/,
);

// 승인 전 로그인 → 승인 대기 상태로 로그인됨
const signedIn = await call("signInTeacher", { loginId: "inviteduser", password: "secret12" });
assert.equal(signedIn.membershipStatus, "pending_registration");
await signInWithCustomToken(auth, signedIn.customToken);
await assert.rejects(call("listAcademyRoles", { academyId: A }), /권한/, "승인 전에는 권한 없음");
await signOut(auth);

// --- 원장: 승인 → 활성 ---
await signInWithEmailAndPassword(auth, "owner2@t.dev", "pass1234");
await call("activateTeacher", { academyId: A, teacherAuthUid: joined.id });
assert.equal((await joined.ref.get()).get("status"), "active");

// --- 원장: 계정 직접 만들기 ---
const hr = await call("saveStaffMember", { academyId: A, displayName: "직접 만든 직원", employmentStatus: "employed" });
const { accounts } = await call("createStaffAccounts", { academyId: A, items: [{ staffId: hr.staffId, roleId: "teacher" }] });
assert.equal(accounts.length, 1);
assert.ok(accounts[0].loginId && accounts[0].tempPassword);
const created = await db.doc(`academies/${A}/staff/${accounts[0].authUid}`).get();
assert.equal(created.get("status"), "pending_setup");
assert.equal(created.get("displayName"), "직접 만든 직원");
await signOut(auth);
const tempLogin = await call("signInTeacher", { loginId: accounts[0].loginId, password: accounts[0].tempPassword });
assert.equal(tempLogin.membershipStatus, "pending_setup");

// --- 멤버 관리 직원: 본인보다 넓은 역할은 줄 수 없음 ---
await signInWithEmailAndPassword(auth, "members@t.dev", "pass1234");
await assert.rejects(
  call("createStaffInvite", { academyId: A, displayName: "x", roleId: "superAdmin" }),
  /본인이 가진 권한까지만/,
);
await assert.rejects(
  call("createStaffAccounts", { academyId: A, items: [{ displayName: "y", roleId: "admin" }] }),
  /본인이 가진 권한까지만/,
);
const narrow = await call("createStaffInvite", { academyId: A, displayName: "범위 안", roleId: "teacher" });
assert.ok(narrow.url);
await signOut(auth);

// --- 폐지된 학원 포털 토큰(role=academy)은 권한 없음 ---
const portalToken = await adminAuth().createCustomToken(`academy_${A}`, { role: "academy", academyId: A });
await signInWithCustomToken(auth, portalToken);
await assert.rejects(call("listAcademyRoles", { academyId: A }), /권한/);
await assert.rejects(call("saveStaffMember", { academyId: A, displayName: "z", employmentStatus: "employed" }), /권한/);

console.log("SMOKE OK (staff invites)");
process.exit(0);
