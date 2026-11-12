/**
 * 홈 "시작하기" 체크리스트(2-M, `getAcademyOnboarding`·`updateAcademyOnboarding`) 통합 스모크 — `npm run test:functions`.
 * 원장만(권한을 모두 가진 직원도 거부), 기록 없음 = 보임, 단계 완료 기준(M2-1: 반·원생·연결 학부모 또는 공유·직원 또는 "직원 없이"),
 * 공유는 처음 시각만, 다 끝나면 사라짐, 숨기기·다시 켜기.
 */
import assert from "node:assert/strict";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A = "o23_a1";

const owner = await adminAuth().createUser({ email: "owner23@t.dev", password: "pass1234", emailVerified: true });
const superStaff = await adminAuth().createUser({ email: "super23@t.dev", password: "pass1234" });
await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "시작 학원", status: "active" });
const { ACADEMY_PERMISSIONS } = (await import("node:module")).createRequire(import.meta.url)(
  "../../functions/lib/lib/permissions.js",
);
await db.doc(`academies/${A}/staff/${superStaff.uid}`).set({
  authUid: superStaff.uid, displayName: "슈퍼", status: "active", roleId: "superAdmin", permissions: ACADEMY_PERMISSIONS,
  isGuest: true,
});

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
const get = () => call("getAcademyOnboarding", { academyId: A });
const act = (action) => call("updateAcademyOnboarding", { academyId: A, action });

await signOut(auth);
await assert.rejects(get(), /로그인/);
await as("super23@t.dev");
await assert.rejects(get(), /원장만/, "권한을 모두 가진 직원도 거부");
await assert.rejects(act("hide"), /원장만/);

await as("owner23@t.dev");
let v = await get();
assert.equal(v.visible, true, "기록 없음 = 보임");
assert.equal(v.doneCount, 0);
assert.equal(v.steps.staff.count, 0, "게스트는 직원 수에 안 셈");
await assert.rejects(act("delete"), /올바르지/);

await db.doc(`academies/${A}/classes/c1`).set({ name: "반", status: "active", teacherUids: [] });
await db.doc(`academies/${A}/students/s1`).set({ name: "원생", status: "enrolled" });
await db.doc(`academies/${A}/parents/p1`).set({ status: "pending_approval", displayName: "대기" });
v = await get();
assert.deepEqual([v.steps.classes.done, v.steps.students.done, v.steps.parents.done, v.steps.staff.done], [true, true, false, false]);

v = await act("parent_link_shared");
assert.equal(v.steps.parents.done, true);
assert.equal(v.steps.parents.shared, true);
const firstShared = (await db.doc(`academies/${A}/meta/onboarding`).get()).get("parentLinkSharedAt");
await new Promise((r) => setTimeout(r, 1100));
await act("parent_link_shared");
assert.equal(
  (await db.doc(`academies/${A}/meta/onboarding`).get()).get("parentLinkSharedAt").toMillis(),
  firstShared.toMillis(), "처음 누른 시각만",
);

v = await act("no_staff");
assert.equal(v.allDone, true);
assert.equal(v.visible, false, "다 끝나면 사라짐");
v = await act("undo_no_staff");
assert.equal(v.steps.staff.done, false);
assert.equal(v.visible, true);
await db.doc(`academies/${A}/staff/hr1`).set({ status: "no_account", isGuest: false, displayName: "미리" });
v = await get();
assert.equal(v.steps.staff.done, true, "미리 등록 직원도 셈");
assert.equal(v.visible, false);

v = await act("show");
assert.equal(v.visible, true, "다시 켜기 — 다 끝났어도 보임");
assert.equal(v.settingOn, true);
v = await act("hide");
assert.equal(v.visible, false);
assert.equal(v.settingOn, false);
await db.doc(`academies/${A}/classes/c1`).delete();
assert.equal((await get()).visible, false, "숨긴 뒤에는 단계가 덜 끝나도 숨김");
assert.equal((await act("show")).visible, true);

await signOut(auth);
console.log("SMOKE OK onboarding");
process.exit(0);
