/**
 * 직원 관리 Callable 통합 스모크 — `npm run test:functions` (Auth·Firestore·Functions 에뮬레이터)
 * 직무 목록 저장·직원 추가/수정/삭제·퇴사 시 계정 비활성화·권한 없는 직원 거부를 확인한다.
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
const A = "o1_a1";

const owner = await adminAuth().createUser({ email: "owner@t.dev", password: "pass1234", emailVerified: true });
const teacher = await adminAuth().createUser({ email: "t@t.dev", password: "pass1234" });
const limited = await adminAuth().createUser({ email: "l@t.dev", password: "pass1234" });
await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "학원" });
await db.doc(`academies/${A}/staff/${teacher.uid}`).set({
  authUid: teacher.uid, displayName: "활성 선생님", status: "active", roleId: "teacher", permissions: [],
});
await db.doc(`academies/${A}/staff/${limited.uid}`).set({
  authUid: limited.uid, displayName: "제한 직원", status: "active", roleId: "x", permissions: ["operations.students"],
});

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);

await signInWithEmailAndPassword(auth, "owner@t.dev", "pass1234");
const { items } = await call("saveAcademyOptionList", {
  academyId: A, kind: "jobTitles", items: [{ label: "강사" }, { label: "행정" }],
});
assert.equal(items.length, 2);
await assert.rejects(
  call("saveAcademyOptionList", { academyId: A, kind: "jobTitles", items: [{ label: "강사" }, { label: "강사" }] }),
  /이미 있습니다/,
);

const created = await call("saveStaffMember", {
  academyId: A, displayName: "새 직원", phone: "010-1234-5678", jobTitleId: items[0].id,
  hireDate: "2026-03-02", employmentStatus: "employed", memo: "수학",
});
const newDoc = (await db.doc(`academies/${A}/staff/${created.staffId}`).get()).data();
assert.equal(newDoc.status, "no_account");
assert.equal(newDoc.jobTitleId, items[0].id);
assert.deepEqual(newDoc.permissions, []);

await assert.rejects(
  call("saveStaffMember", { academyId: A, displayName: "x", jobTitleId: "nope", employmentStatus: "employed" }),
  /직무/,
);
await assert.rejects(
  call("saveStaffMember", { academyId: A, displayName: "x", hireDate: "2026-02-30", employmentStatus: "employed" }),
  /입사일/,
);

const resigned = await call("saveStaffMember", {
  academyId: A, staffId: teacher.uid, displayName: "활성 선생님", employmentStatus: "resigned",
});
assert.equal(resigned.accountDeactivated, true);
assert.equal((await db.doc(`academies/${A}/staff/${teacher.uid}`).get()).get("status"), "inactive");
assert.equal((await adminAuth().getUser(teacher.uid)).disabled, true);

await assert.rejects(call("deleteStaffMember", { academyId: A, staffId: teacher.uid }), /계정이 있는 직원/);
await call("deleteStaffMember", { academyId: A, staffId: created.staffId });
assert.equal((await db.doc(`academies/${A}/staff/${created.staffId}`).get()).exists, false);

await signOut(auth);
await signInWithEmailAndPassword(auth, "l@t.dev", "pass1234");
await assert.rejects(
  call("saveStaffMember", { academyId: A, displayName: "x", employmentStatus: "employed" }),
  /권한/,
);
await assert.rejects(
  call("saveAcademyOptionList", { academyId: A, kind: "jobTitles", items: [] }),
  /권한/,
);
console.log("SMOKE OK");
process.exit(0);
