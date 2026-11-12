/**
 * 학부모 자동 연결·직원 자동 활성(2-L L-2) 통합 스모크 — `npm run test:functions`(가짜 OCTOMO).
 * 가입 때 자동 연결(형제·퇴원 제외·다른 계정 색인·같은 번호 확인 계정 2개), 원생 저장 때 자동 연결(학생 트리거) —
 * 트리거 재시도에도 연결 1번·벨 1건(같은 처리를 다시 돌려 확인)·루프 없음, 설정 끔·권한, 번호 미확인은 연결 안 됨,
 * "내 자녀가 아니에요"·원장 해제 뒤 같은 원생을 다시 저장해도 재연결 안 됨·원장 직접 연결은 됨,
 * 직원 자동 활성(후보 1명 + 역할 / 2명 / 역할 없음 / 번호 미확인).
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
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
import { CONSENTS, seedSignupToken } from "./_signup-token.mjs";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A = "o13_a1";

// 서버 라이브러리를 직접 다시 돌려 "트리거 재시도"를 흉내 내기 위한 functions 쪽 Admin 앱
const requireFns = createRequire(new URL("../../functions/package.json", import.meta.url));
const fnsAdmin = requireFns("firebase-admin");
const fnsApp = fnsAdmin.apps.length ? fnsAdmin.app() : fnsAdmin.initializeApp({ projectId: PROJECT });
const fnsDb = fnsApp.firestore();
const { autoLinkNewGuardianPhones } = requireFns("./lib/lib/parent-auto-link.js");

// 같은 에뮬레이터에서 앞 스모크가 쓴 IP 발급 카운터(127.0.0.1) 정리
for (const d of (await db.collection("phoneVerificationCounters").get()).docs) {
  if (d.id.startsWith("ip_hr_")) await d.ref.delete();
}

const owner = await adminAuth().createUser({ email: "owner13@t.dev", password: "pass1234", emailVerified: true });
const studentsOnly = await adminAuth().createUser({ email: "stu13@t.dev", password: "pass1234" });
await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "자동 연결 학원", status: "active" });
await db.doc(`academies/${A}/meta/seq`).set({ nextTeacherSeq: 1, nextParentSeq: 1, nextStudentSeq: 1 });
await db.doc(`academies/${A}/meta/options`).set({ guardianRelations: [{ id: "mother", label: "어머니" }, { id: "father", label: "아버지" }] });
await db.doc(`academies/${A}/staff/${studentsOnly.uid}`).set({
  authUid: studentsOnly.uid, displayName: "원생 담당", status: "active", roleId: "x", permissions: ["operations.students"],
});
const P = await seedSignupToken(db, A, "parent");
const S = await seedSignupToken(db, A, "staff");

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);

const asOwner = async () => {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, "owner13@t.dev", "pass1234");
};
const parentDoc = (uid) => db.doc(`academies/${A}/parents/${uid}`).get();
const student = async (id) => (await db.doc(`academies/${A}/students/${id}`).get()).data();
const bell = (id) => db.doc(`academies/${A}/adminInbox/${id}`).get();
const bellsOfKind = async (kind) =>
  (await db.collection(`academies/${A}/adminInbox`).where("kind", "==", kind).get()).docs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, check, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new Error(`시간 초과: ${label}`);
    await sleep(250);
  }
}

const mirror = async (uid) => (await db.doc(`users/${uid}/serverMirror/activation`).get()).data() ?? {};
/**
 * 자동 활성·자동 연결 직후 바로 이용 — 클레임(서버가 활성과 함께 씀)·로그인 응답은 바로 active,
 * 미러(트리거가 씀)는 짧게 기다려 active, 그 뒤 3초가 지나도 옛 상태(대기)로 덮이지 않음(2-L L-3 보강).
 */
async function assertStaysActive(role, uid, loginId) {
  assert.equal((await adminAuth().getUser(uid)).customClaims?.membershipStatus, "active", `${loginId}: 직후 클레임`);
  const login = await call(role === "teacher" ? "signInTeacher" : "signInParent", { loginId, password: "pw123456" });
  assert.equal(login.membershipStatus, "active", `${loginId}: 로그인 응답`);
  await waitFor(`${loginId}: 미러 active`, async () => (await mirror(uid))[role]?.primaryStatus === "active", 10000);
  await sleep(3000);
  assert.equal((await adminAuth().getUser(uid)).customClaims?.membershipStatus, "active", `${loginId}: 대기 뒤 클레임`);
  assert.equal((await mirror(uid))[role]?.primaryStatus, "active", `${loginId}: 대기 뒤 미러`);
}

/** 번호 확인(가짜 OCTOMO true) → 증표 */
async function proofFor(phone, purpose = "parent_signup", token = P) {
  const s = await call("startPhoneVerification", { purpose, token, phone });
  assert.equal(s.status, "issued", phone);
  const c = await call("checkPhoneVerification", { verificationId: s.verificationId });
  assert.equal(c.status, "verified", phone);
  return c.proof;
}

let n = 0;
/** 학부모 아이디 가입(verify=true면 번호 확인) → { res, uid, loginId } */
async function parentSignup(phone, verify = true) {
  n += 1;
  await signOut(auth);
  const loginId = `autolink${n}`;
  const res = await call("registerParentSelfSignup", {
    token: P, loginId, displayName: `학부모${n}`, phone, password: "pw123456", consents: CONSENTS,
    ...(verify ? { phoneProof: await proofFor(phone) } : {}),
  });
  const uid = (await db.doc(`attnLoginIndex/${res.loginId}`).get()).get("authUid");
  return { res, uid, loginId };
}

const MOM = "010-2100-0001";
const MOM_KEY = "01021000001";
const DAD = "010-2100-0002";
const TAKEN = "010-2100-0003";
const LATE = "010-2100-0004";
const OFF = "010-2100-0005";
const TWIN = "010-2100-0006";
const SKIP = "010-2100-0007";

// --- 원생 준비 ---
await asOwner();
const mk = async (name, guardians, status = "enrolled") =>
  (await call("saveStudent", { academyId: A, name, grade: "e3", status, guardians })).studentId;
const s1 = await mk("형", [{ relationId: "mother", name: "엄마", phone: MOM }]);
const s2 = await mk("동생", [{ relationId: "mother", name: "엄마", phone: MOM }, { relationId: "father", phone: DAD }]);
const s3 = await mk("퇴원생", [{ relationId: "mother", phone: MOM }], "withdrawn");
const sTaken = await mk("다른 집", [{ relationId: "father", phone: TAKEN }]);
// 다른 계정이 TAKEN 번호 색인을 잡음(학원이 직접 만든 계정 연결)
await call("createParentAccount", { academyId: A, displayName: "직접 만든 보호자", phone: TAKEN, studentIds: [sTaken] });
const skipStudent = await mk("확인 안 함", [{ relationId: "mother", phone: SKIP }]);

// --- 가입 때 자동 연결: 형제 2명(퇴원 제외) → 사용 중·벨 원생마다 1건 ---
const mom = await parentSignup(MOM);
assert.equal(mom.res.phoneVerified, true);
assert.equal(mom.res.linkedCount, 2);
assert.equal(mom.res.membershipStatus, "active");
let momSnap = await parentDoc(mom.uid);
assert.equal(momSnap.get("status"), "active");
assert.equal(momSnap.get("approvedVia"), "phone_auto");
assert.equal(momSnap.get("approvedByUid"), null);
assert.ok(momSnap.get("approvedAt"));
assert.deepEqual([...(momSnap.get("linkedStudentIds") ?? [])].sort(), [s1, s2].sort());
assert.equal((await adminAuth().getUser(mom.uid)).customClaims.membershipStatus, "active");
assert.equal((await db.doc(`academies/${A}/parentPhones/${MOM_KEY}`).get()).get("parentUid"), mom.uid);
assert.ok(!(await student(s3)).parentUids.includes(mom.uid), "퇴원생은 자동 연결 안 함");
for (const sid of [s1, s2]) {
  const b = await bell(`p-autolink-${mom.uid}-${sid}`);
  assert.equal(b.get("kind"), "parent_auto_linked");
  assert.equal(b.get("displayName"), momSnap.get("displayName"));
  assert.ok(b.get("studentName"));
  assert.equal(JSON.stringify(b.data()).includes(MOM_KEY), false, "벨에 전화번호 없음");
  assert.ok(b.get("expiresAt"));
}
// 학부모가 바로 로그인해 자녀를 봄
await signOut(auth);
const momLogin = await call("signInParent", { loginId: mom.loginId, password: "pw123456" });
assert.equal(momLogin.membershipStatus, "active");
await signInWithCustomToken(auth, momLogin.customToken);
const kids = await call("listParentChildrenStudents", { academyId: A });
assert.deepEqual(kids.students.map((s) => s.id).sort(), [s1, s2].sort());

// --- 다른 계정이 그 번호 색인을 잡고 있으면 자동 연결 없이 승인 대기 ---
const taken = await parentSignup(TAKEN);
assert.equal(taken.res.phoneVerified, true);
assert.equal(taken.res.linkedCount, 0);
assert.equal(taken.res.membershipStatus, "pending_approval");

// --- 번호 확인 없이 가입하면 일치 원생이 있어도 연결 안 함(응답에도 0) ---
const skipper = await parentSignup(SKIP, false);
assert.equal(skipper.res.linkedCount, 0);
assert.equal((await parentDoc(skipper.uid)).get("status"), "pending_approval");

// --- 원생을 나중에 넣을 때 자동 연결(학생 트리거) — 벨 1건·연결 1번·루프 없음 ---
const dad = await parentSignup(LATE);
assert.equal(dad.res.linkedCount, 0, "아직 일치 원생 없음");
await asOwner();
const sLate = await mk("나중 원생", [{ relationId: "father", phone: LATE }]);
await waitFor("나중 원생 자동 연결", async () => (await student(sLate)).parentUids?.includes(dad.uid));
await waitFor("아빠 사용 중", async () => (await parentDoc(dad.uid)).get("status") === "active");
await sleep(2500); // 연결 쓰기로 다시 깬 트리거가 끝날 시간
assert.equal((await bellsOfKind("parent_auto_linked")).filter((d) => d.get("entityId") === dad.uid).length, 1, "벨 1건");
const lateGuardians = (await student(sLate)).guardians;
assert.equal(lateGuardians.length, 1, "칸을 새로 만들지 않음");
assert.equal(lateGuardians.filter((g) => g.linkedParentUid === dad.uid).length, 1, "연결 1번");
// 트리거 재시도 흉내 — 같은 처리를 그대로 다시 돌려도 연결·벨이 늘지 않음
assert.equal(await autoLinkNewGuardianPhones(fnsDb, A, sLate, ["01021000004"]), 0);
assert.equal((await bellsOfKind("parent_auto_linked")).filter((d) => d.get("entityId") === dad.uid).length, 1);
assert.equal((await student(sLate)).guardians.filter((g) => g.linkedParentUid === dad.uid).length, 1);
// 번호와 무관한 원생 수정(이름) → 트리거는 깨지만 새 번호 없음 → 아무 일 없음
await call("saveStudent", { academyId: A, studentId: sLate, name: "나중 원생2", grade: "e3", status: "enrolled" });
await sleep(1500);
assert.equal((await bellsOfKind("parent_auto_linked")).filter((d) => d.get("entityId") === dad.uid).length, 1);

// --- 번호 미확인 계정은 원생 저장 때도 연결 안 함 ---
await call("saveStudent", {
  academyId: A, studentId: skipStudent, name: "확인 안 함", grade: "e3", status: "enrolled",
  guardians: [{ relationId: "mother", phone: SKIP }, { relationId: "father", phone: "010-2100-0099" }],
});
await sleep(2000);
assert.ok(!(await student(skipStudent)).parentUids?.includes(skipper.uid));

// --- 같은 번호로 확인한 계정이 둘이면(★7) 원생을 넣어도 연결 안 함 ---
const twinA = await parentSignup(TWIN);
const twinB = await parentSignup(TWIN);
await asOwner();
const sTwin = await mk("쌍둥이 번호", [{ relationId: "mother", phone: TWIN }]);
await sleep(2500);
assert.deepEqual((await student(sTwin)).parentUids, []);
assert.equal((await parentDoc(twinA.uid)).get("status"), "pending_approval");
assert.equal((await parentDoc(twinB.uid)).get("status"), "pending_approval");

// --- 학원 설정 끔(학부모 관리 권한) → 가입·원생 저장 모두 연결 안 함, 다시 켬 ---
await signOut(auth);
await signInWithEmailAndPassword(auth, "stu13@t.dev", "pass1234");
await assert.rejects(call("setParentAutoLink", { academyId: A, enabled: false }), /권한/);
await asOwner();
assert.equal((await call("getSignupLink", { academyId: A, kind: "parent" })).autoLinkVerifiedParents, true, "기본 켜짐");
assert.equal((await call("getSignupLink", { academyId: A, kind: "staff" })).autoLinkVerifiedParents, undefined);
await call("setParentAutoLink", { academyId: A, enabled: false });
assert.equal((await call("getSignupLink", { academyId: A, kind: "parent" })).autoLinkVerifiedParents, false);
const sOff = await mk("설정 끔 원생", [{ relationId: "mother", phone: OFF }]);
const offParent = await parentSignup(OFF);
assert.equal(offParent.res.linkedCount, 0);
await asOwner();
const sOff2 = await mk("설정 끔 원생2", [{ relationId: "mother", phone: OFF }]);
await sleep(2500);
assert.deepEqual((await student(sOff)).parentUids, []);
assert.deepEqual((await student(sOff2)).parentUids, []);
await call("setParentAutoLink", { academyId: A, enabled: true });

// --- "내 자녀가 아니에요" — 그 연결만 해제·벨·다시 저장해도 재연결 안 됨 ---
await signOut(auth);
await signInWithCustomToken(auth, (await call("signInParent", { loginId: mom.loginId, password: "pw123456" })).customToken);
await call("declineParentChildLink", { studentId: s2 });
assert.ok(!(await student(s2)).parentUids.includes(mom.uid));
assert.ok((await student(s1)).parentUids.includes(mom.uid), "다른 자녀 연결은 그대로");
assert.ok((await student(s2)).guardians.some((g) => g.phone === MOM && !g.linkedParentUid), "보호자 연락처는 남김");
momSnap = await parentDoc(mom.uid);
assert.deepEqual(momSnap.get("autoLinkBlockedStudentIds"), [s2]);
assert.equal((await bell(`p-decline-${mom.uid}-${s2}`)).get("kind"), "parent_child_declined");
await assert.rejects(call("declineParentChildLink", { studentId: s2 }), /이미 연결이 해제/);
await asOwner();
await assert.rejects(call("declineParentChildLink", { studentId: s1 }), /학부모 계정만/);
// 원장이 보호자 칸을 지웠다가 다시 넣어도(새 번호로 보임) 자동 연결 안 됨
await call("saveStudent", { academyId: A, studentId: s2, name: "동생", grade: "e3", status: "enrolled", guardians: [{ relationId: "father", phone: DAD }] });
await call("saveStudent", {
  academyId: A, studentId: s2, name: "동생", grade: "e3", status: "enrolled",
  guardians: [{ relationId: "father", phone: DAD }, { relationId: "mother", phone: MOM }],
});
await sleep(2500);
assert.ok(!(await student(s2)).parentUids.includes(mom.uid), "되살아남 없음(내 자녀 아님)");

// --- 원장 해제 → 다시 저장해도 재연결 안 됨 → 원장이 직접 연결하면 됨(표시 지움) ---
await call("unlinkParentFromStudent", { academyId: A, parentUid: mom.uid, studentId: s1 });
assert.deepEqual([...(await parentDoc(mom.uid)).get("autoLinkBlockedStudentIds")].sort(), [s1, s2].sort());
await call("saveStudent", { academyId: A, studentId: s1, name: "형", grade: "e3", status: "enrolled", guardians: [] });
await call("saveStudent", { academyId: A, studentId: s1, name: "형", grade: "e3", status: "enrolled", guardians: [{ relationId: "mother", phone: MOM }] });
await sleep(2500);
assert.ok(!(await student(s1)).parentUids.includes(mom.uid), "되살아남 없음(원장 해제)");
const manual = await call("linkParentToStudents", { academyId: A, parentUid: mom.uid, studentIds: [s1] });
assert.deepEqual(manual.linked, [s1]);
assert.deepEqual((await parentDoc(mom.uid)).get("autoLinkBlockedStudentIds"), [s2], "직접 연결한 원생은 표시 지움");

// --- 직원 자동 활성 ---
const { roles } = await call("listAcademyRoles", { academyId: A });
assert.ok(roles.some((r) => r.id === "lessonManager"));
const hr = async (displayName, phone, roleId) => {
  const r = await call("saveStaffMember", { academyId: A, displayName, phone, employmentStatus: "employed" });
  if (roleId) await call("setStaffSignupRole", { academyId: A, staffId: r.staffId, roleId });
  return r.staffId;
};
const H1 = "010-3100-0001";
const H2 = "010-3100-0002";
const H3 = "010-3100-0003";
const H4 = "010-3100-0004";
const hr1 = await hr("미리 선생", H1, "lessonManager");
await hr("같은 번호 1", H2, "teacher");
await hr("같은 번호 2", H2, "teacher");
await hr("역할 없음", H3, null);
await hr("확인 안 함", H4, "teacher");
await signOut(auth);
const staffSignup = async (loginId, phone, verify) =>
  call("registerStaffSignup", {
    token: S, method: "password", displayName: `가입 ${loginId}`, phone, loginId, password: "pw123456", consents: CONSENTS,
    ...(verify ? { phoneProof: await proofFor(phone, "staff_signup", S) } : {}),
  });
const staffByLogin = async (loginId) =>
  (await db.collection(`academies/${A}/staff`).where("loginId", "==", loginId).get()).docs[0];

// 후보 1명 + 역할 → 바로 사용 중, 인사 정보 합침, 벨
const a1 = await staffSignup("autostaff1", H1, true);
assert.equal(a1.membershipStatus, "active");
const st1 = await staffByLogin("autostaff1");
assert.equal(st1.get("status"), "active");
assert.equal(st1.get("roleId"), "lessonManager");
assert.equal(st1.get("mergedFromStaffId"), hr1);
assert.equal(st1.get("displayName"), "미리 선생", "미리 등록한 이름");
assert.equal((await db.doc(`academies/${A}/staff/${hr1}`).get()).exists, false, "인사 문서 합쳐짐");
const sb = await bell(`s-autoact-${st1.id}`);
assert.equal(sb.get("kind"), "staff_auto_activated");
assert.equal(sb.get("roleId"), "lessonManager");
await assertStaysActive("teacher", st1.id, "autostaff1");
// 후보 2명 / 역할 없음 / 번호 미확인 → 승인 대기
for (const [loginId, phone, verify] of [["autostaff2", H2, true], ["autostaff3", H3, true], ["autostaff4", H4, false]]) {
  const r = await staffSignup(loginId, phone, verify);
  assert.equal(r.membershipStatus, "pending_registration", loginId);
  assert.equal((await staffByLogin(loginId)).get("status"), "pending_registration", loginId);
}
assert.equal((await bellsOfKind("staff_auto_activated")).length, 1);

// --- 클레임·미러 늦은 덮어쓰기 가드(2-L L-3 보강) — 생성과 활성이 한 요청에서 일어나는 두 경로를 여러 번 반복 ---
// 직원 자동 활성(provision → merge)
for (let i = 1; i <= 6; i += 1) {
  const phone = `010-3300-000${i}`;
  await asOwner();
  await hr(`반복 선생${i}`, phone, "lessonManager");
  await signOut(auth);
  const r = await staffSignup(`racestaff${i}`, phone, true);
  assert.equal(r.membershipStatus, "active", `반복 직원 ${i}`);
  await assertStaysActive("teacher", (await staffByLogin(`racestaff${i}`)).id, `racestaff${i}`);
}
// 학부모 가입 자동 연결(pending_approval → active)
for (let i = 1; i <= 6; i += 1) {
  const phone = `010-2200-000${i}`;
  await asOwner();
  await mk(`반복 원생${i}`, [{ relationId: "mother", phone }]);
  const p = await parentSignup(phone);
  assert.equal(p.res.membershipStatus, "active", `반복 학부모 ${i}`);
  assert.equal(p.res.linkedCount, 1);
  await assertStaysActive("parent", p.uid, p.loginId);
}
// 결정적 재현 — "먼저 계산하고 늦게 쓰는 실행": 옛 상태(대기)로 계산해 둔 값으로 시작해도 쓰고 다시 확인해 active로 끝남
const { reconcileUserActivationMirror } = requireFns("./lib/user-activation-mirror.js");
const staleTeacher = {
  teacher: { anyActive: false, primaryStatus: "pending_registration", primaryAcademyId: A },
  parent: { anyActive: false, primaryStatus: null, primaryAcademyId: null },
};
const fixed = await reconcileUserActivationMirror(fnsDb, st1.id, "trigger", { precomputed: staleTeacher });
assert.equal(fixed.teacher.primaryStatus, "active", "다시 계산한 값");
assert.equal((await adminAuth().getUser(st1.id)).customClaims.membershipStatus, "active", "옛 값으로 덮이지 않음(클레임)");
assert.equal((await mirror(st1.id)).teacher.primaryStatus, "active", "옛 값으로 덮이지 않음(미러)");
const staleParent = {
  teacher: { anyActive: false, primaryStatus: null, primaryAcademyId: null },
  parent: { anyActive: false, primaryStatus: "pending_approval", primaryAcademyId: A },
};
await reconcileUserActivationMirror(fnsDb, mom.uid, "trigger", { precomputed: staleParent });
assert.equal((await adminAuth().getUser(mom.uid)).customClaims.membershipStatus, "active");
assert.equal((await mirror(mom.uid)).parent.primaryStatus, "active");

console.log("SMOKE OK parent-auto-link");
process.exit(0);
