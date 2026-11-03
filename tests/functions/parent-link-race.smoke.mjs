/**
 * 학부모 연결 경합 스모크(2-H) — `npm run test:functions` (Auth·Firestore·Functions 에뮬레이터)
 * - 단위 수준: 학생별 연결 트랜잭션(`linkParentToStudentTx`)을 낡은 번호(트랜잭션 밖에서 읽은 값)로 부르면 거부되고
 *   옛 번호 색인이 생기지 않으며 학생도 연결되지 않는다. 삭제·비활성 계정도 거부.
 * - 통합: 학부모 번호 변경(`updateParentProfile`)과 첫 연결(`linkParentToStudents`)을 동시에 보내도
 *   끝난 뒤 계정 번호와 색인 번호가 같다(이 계정이 잡은 색인은 지금 번호 하나뿐, 연결됐으면 그 색인이 있음).
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { deleteApp, initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  signInWithCustomToken,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

// 컴파일된 functions 라이브러리를 functions 쪽 firebase-admin과 함께 쓴다(FieldValue 인스턴스가 같아야 함)
const requireFn = createRequire(new URL("../../functions/package.json", import.meta.url));
const fadmin = requireFn("firebase-admin");
const { linkParentToStudentTx, PARENT_ACCOUNT_CHANGED_MSG } = requireFn("./lib/lib/parent-links.js");

const PROJECT = "demo-attn";
fadmin.initializeApp({ projectId: PROJECT });
const db = fadmin.firestore();
const A = "o10_a1";

const owner = await fadmin.auth().createUser({ email: "owner10@t.dev", password: "pass1234", emailVerified: true });
await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "경합 학원", status: "active" });
await db.doc(`academies/${A}/meta/seq`).set({ nextTeacherSeq: 1, nextParentSeq: 1, nextStudentSeq: 1 });
await db.doc(`academies/${A}/meta/options`).set({ guardianRelations: [{ id: "mother", label: "어머니" }] });

let appSeq = 0;
function device() {
  const app = initializeApp({ projectId: PROJECT, apiKey: "fake" }, `race-${++appSeq}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const fns = getFunctions(app, "asia-northeast3");
  connectFunctionsEmulator(fns, "127.0.0.1", 5001);
  return { app, auth, call: (name, data) => httpsCallable(fns, name)(data).then((r) => r.data) };
}
const ownerDev = device();
await signInWithEmailAndPassword(ownerDev.auth, "owner10@t.dev", "pass1234");

const digits = (p) => String(p ?? "").replace(/\D/g, "");
const indexDoc = (phone) => db.doc(`academies/${A}/parentPhones/${digits(phone)}`);
const parentRef = (uid) => db.doc(`academies/${A}/parents/${uid}`);

async function mkStudent(name, phone) {
  const r = await ownerDev.call("saveStudent", {
    academyId: A, name, grade: "e3", status: "enrolled",
    guardians: [{ relationId: "mother", name: "엄마", phone }],
  });
  return r.studentId;
}

/** 직접 만든 계정을 첫 로그인까지 마쳐 연결 대기(번호 색인 보유)로 — 그 뒤 연결을 모두 해제 */
async function createParent(n, phone) {
  const holder = await mkStudent(`보유 ${n}`, phone);
  const made = await ownerDev.call("createParentAccount", {
    academyId: A, displayName: `엄마 ${n}`, phone, studentIds: [holder],
  });
  return { uid: made.authUid, loginId: made.loginId, tempPassword: made.tempPassword, holder };
}

// --- 단위: 낡은 번호로 학생별 연결 ---
const P_OLD = "010-3100-0001";
const P_NEW = "010-3100-0002";
const stale = await mkStudent("낡은 번호 원생", P_OLD);
const staleParent = await fadmin.auth().createUser({ email: "stale10@t.dev", password: "pass1234" });
await parentRef(staleParent.uid).set({
  authUid: staleParent.uid, displayName: "번호 바꾼 엄마", phone: P_OLD, status: "pending_approval",
  linkedStudentIds: [], approvedAt: null, academyId: A,
});
// 바깥에서 P_OLD를 읽은 뒤 학부모가 번호를 바꿈
await parentRef(staleParent.uid).update({ phone: P_NEW });
await assert.rejects(
  linkParentToStudentTx(db, A, { uid: staleParent.uid, phone: P_OLD, displayName: "번호 바꾼 엄마" }, stale),
  (e) => e.message === PARENT_ACCOUNT_CHANGED_MSG,
);
assert.equal((await indexDoc(P_OLD).get()).exists, false, "옛 번호 색인이 생기지 않음");
assert.equal(
  (await db.doc(`academies/${A}/students/${stale}`).get()).get("guardians")[0].linkedParentUid,
  null,
  "학생 미연결",
);
// 비활성·삭제 계정 거부
await parentRef(staleParent.uid).update({ status: "inactive" });
const another = await mkStudent("다른 원생", P_NEW);
await assert.rejects(
  linkParentToStudentTx(db, A, { uid: staleParent.uid, phone: P_NEW, displayName: "x" }, another),
  /비활성 계정은/,
);
await parentRef(staleParent.uid).delete();
await assert.rejects(
  linkParentToStudentTx(db, A, { uid: staleParent.uid, phone: P_NEW, displayName: "x" }, another),
  /학부모 계정을 찾을 수 없습니다/,
);

// --- 통합: 번호 변경과 첫 연결 동시 ---
/** 이 계정이 잡은 색인이 지금 번호 하나뿐인지(연결됐으면 반드시 있음) */
async function assertIndexMatchesPhone(uid, label) {
  const p = await parentRef(uid).get();
  const phone = p.get("phone");
  const held = (await db.collection(`academies/${A}/parentPhones`).where("parentUid", "==", uid).get()).docs.map((d) => d.id);
  const linked = await db.collection(`academies/${A}/students`).where("parentUids", "array-contains", uid).get();
  if (!linked.empty) assert.deepEqual(held, [digits(phone)], `${label}: 연결된 계정 색인 = 계정 번호`);
  else assert.ok(held.every((k) => k === digits(phone)), `${label}: 남은 색인 = 계정 번호`);
  // (연결이 먼저 끝난 뒤 번호를 바꾸면 원생 쪽 보호자 번호는 그대로 — 2-G B2 "번호 다름" 표시, 의도된 동작)
  return { linked: !linked.empty, phone };
}

const ROUNDS = 4;
const outcomes = [];
for (let i = 0; i < ROUNDS; i++) {
  const oldPhone = `010-32${String(i).padStart(2, "0")}-1111`;
  const newPhone = `010-32${String(i).padStart(2, "0")}-2222`;
  // 아직 한 번도 연결되지 않은 계정(색인 없음)과 같은 상태 준비: 직접 만들기 → 첫 로그인 → 연결 해제 → 색인 삭제
  const acct = await createParent(`경합${i}`, oldPhone);
  const parentDev = device();
  const signIn = await parentDev.call("signInParent", { loginId: acct.loginId, password: acct.tempPassword });
  await signInWithCustomToken(parentDev.auth, signIn.customToken);
  const first = await parentDev.call("completeMemberFirstLogin", { newPassword: "racepw99" });
  await signInWithCustomToken(parentDev.auth, first.customToken);
  await ownerDev.call("unlinkParentFromStudent", { academyId: A, parentUid: acct.uid, studentId: acct.holder });
  await indexDoc(oldPhone).delete(); // 처음 연결 전 상태(색인 없음)로
  const target = await mkStudent(`경합 원생 ${i}`, oldPhone);

  const [linkRes, profileRes] = await Promise.allSettled([
    ownerDev.call("linkParentToStudents", { academyId: A, parentUid: acct.uid, studentIds: [target] }),
    parentDev.call("updateParentProfile", { displayName: `엄마 경합${i}`, phone: newPhone }),
  ]);
  assert.equal(profileRes.status, "fulfilled", `번호 변경 성공(${i})`);
  if (linkRes.status === "fulfilled" && linkRes.value.failures.length) {
    assert.match(linkRes.value.failures[0].message, /계정 정보가 바뀌었습니다|이미 다른 학부모 계정/);
  }
  const r = await assertIndexMatchesPhone(acct.uid, `라운드 ${i}`);
  assert.equal(digits(r.phone), digits(newPhone));
  outcomes.push(r.linked ? "linked" : "rejected");
  await deleteApp(parentDev.app);
}
console.log("race outcomes", outcomes.join(","));

console.log("SMOKE OK");
process.exit(0);
