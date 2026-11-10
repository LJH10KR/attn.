/**
 * 번호 변경 재확인(2-L L-3) 통합 스모크 — `npm run test:functions`(가짜 OCTOMO).
 * - 학부모 본인 번호 변경: 증표 필수·재사용 거부, 계정 번호·확인 필드·색인·연결된 모든 보호자 칸 동기화, ★9 칸 합치기,
 *   다른 계정 색인 번호 거부, ★8 "첫째만 연결 → 번호 변경 → 학원이 새 번호를 미리 적은 둘째도 자동 연결", 벨(전화번호 없음)
 * - 학원이 연결된 칸 번호 변경 → phoneNotice(같은 트랜잭션)·응답 phoneNoticeCount, 원래 번호로 고치면 항목 삭제,
 *   revert(계정 번호가 확인된 번호일 때만)·confirm(학원 번호와 다르면 corrected, 같으면 self)
 * - 직원 본인 번호 변경 증표 필수·비우기, 원장이 인사 정보 번호를 바꾸면 확인 해제
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
import { CONSENTS, seedSignupToken } from "./_signup-token.mjs";

const PROJECT = "demo-attn";
initAdmin({ projectId: PROJECT });
const db = adminDb();
const A = "o14_a1";

// 같은 에뮬레이터에서 앞 스모크가 쓴 IP 발급 카운터(127.0.0.1) 정리
for (const d of (await db.collection("phoneVerificationCounters").get()).docs) {
  if (d.id.startsWith("ip_hr_")) await d.ref.delete();
}

const owner = await adminAuth().createUser({ email: "owner14@t.dev", password: "pass1234", emailVerified: true });
await db.doc(`academies/${A}`).set({ ownerUid: owner.uid, name: "번호 변경 학원", status: "active" });
await db.doc(`academies/${A}/meta/seq`).set({ nextTeacherSeq: 1, nextParentSeq: 1, nextStudentSeq: 1 });
await db.doc(`academies/${A}/meta/options`).set({
  guardianRelations: [{ id: "mother", label: "어머니" }, { id: "father", label: "아버지" }],
});
const P = await seedSignupToken(db, A, "parent");
const S = await seedSignupToken(db, A, "staff");

const app = initializeApp({ projectId: PROJECT, apiKey: "fake" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app, "asia-northeast3");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);

const digits = (p) => String(p ?? "").replace(/\D/g, "");
const asOwner = async () => {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, "owner14@t.dev", "pass1234");
};
const parentDoc = async (uid) => (await db.doc(`academies/${A}/parents/${uid}`).get()).data();
const student = async (id) => (await db.doc(`academies/${A}/students/${id}`).get()).data();
const indexHolder = async (phone) => (await db.doc(`academies/${A}/parentPhones/${digits(phone)}`).get()).get("parentUid");
const bell = async (id) => (await db.doc(`academies/${A}/adminInbox/${id}`).get()).data();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 번호 확인(가짜 OCTOMO true) → 증표 — 가입은 토큰, 번호 변경은 지금 로그인한 본인 */
async function proofFor(phone, purpose, token) {
  const s = await call("startPhoneVerification", { purpose, phone, ...(token ? { token } : {}) });
  assert.equal(s.status, "issued", phone);
  const c = await call("checkPhoneVerification", { verificationId: s.verificationId });
  assert.equal(c.status, "verified", phone);
  return c.proof;
}

async function parentSignup(loginId, displayName, phone, verify) {
  await signOut(auth);
  const res = await call("registerParentSelfSignup", {
    token: P, loginId, displayName, phone, password: "pw123456", consents: CONSENTS,
    ...(verify ? { phoneProof: await proofFor(phone, "parent_signup", P) } : {}),
  });
  const uid = (await db.doc(`attnLoginIndex/${res.loginId}`).get()).get("authUid");
  return { res, uid, loginId };
}
const asParent = async (loginId) => {
  await signOut(auth);
  await signInWithCustomToken(auth, (await call("signInParent", { loginId, password: "pw123456" })).customToken);
};

const M1 = "010-4100-0001"; // 엄마 처음 번호
const M2 = "010-4100-0002"; // 엄마 새 번호(학원이 둘째에 미리 적음)
const TAKEN = "010-4100-0003"; // 다른 계정 색인
const A1 = "010-4100-0011"; // 학원이 잘못 고친 번호
const A2 = "010-4100-0012";
const C = "010-4100-0013"; // 학부모가 확인한 진짜 번호
const D = "010-4100-0014";
const F = "010-4100-0021"; // 확인 안 한 아빠

// --- 원생: 첫째(엄마 M1 + 새 번호 M2 칸이 대표), 둘째(학원이 새 번호 M2를 미리 적음) ---
await asOwner();
const mk = async (name, guardians) =>
  (await call("saveStudent", { academyId: A, name, grade: "e3", status: "enrolled", guardians })).studentId;
const s1 = await mk("첫째", [
  { relationId: "mother", name: "엄마", phone: M1 },
  { relationId: null, name: "엄마 새 번호", phone: M2, isPrimary: true },
]);
const sTaken = await mk("다른 집", [{ relationId: "father", phone: TAKEN }]);
await call("createParentAccount", { academyId: A, displayName: "직접 만든 보호자", phone: TAKEN, studentIds: [sTaken] });

// 엄마 가입(번호 확인) → 첫째만 자동 연결(둘째는 아직 없음)
const mom = await parentSignup("phonemom", "엄마", M1, true);
assert.equal(mom.res.linkedCount, 1);
await asOwner();
const s2 = await mk("둘째", [{ relationId: "mother", phone: M2 }]);
await sleep(2000); // 학생 트리거 — M2로 확인한 계정 없음 → 연결 없음
assert.deepEqual((await student(s2)).parentUids, []);
assert.equal(await indexHolder(M1), mom.uid);

// --- 학부모 본인 번호 변경: 증표 없으면 거부 ---
await asParent(mom.loginId);
await assert.rejects(call("updateParentProfile", { phone: M2 }), /문자 확인/);
await assert.rejects(call("updateParentProfile", { displayName: "엄마", phone: M2 }), /문자 확인/);
// 이름만 바꾸기는 그대로
assert.equal((await call("updateParentProfile", { displayName: "엄마A" })).displayName, "엄마A");
// 다른 계정 번호 증표는 쓸 수 없음(증표 번호와 요청 번호가 다름)
const proofM2 = await proofFor(M2, "phone_change");
await assert.rejects(call("updateParentProfile", { phone: A1, phoneProof: proofM2 }), /번호 확인을 마친 번호와/);

// --- 증표로 변경 → 계정·확인 필드·색인·연결된 칸(★9 합치기)·★8 둘째 자동 연결·벨 ---
const changed = await call("updateParentProfile", { phone: M2, phoneProof: proofM2 });
assert.equal(changed.phoneVerified, true);
assert.equal(changed.linkedCount, 1, "★8 — 학원이 새 번호를 미리 적은 둘째 자동 연결");
let momDoc = await parentDoc(mom.uid);
assert.equal(digits(momDoc.phone), digits(M2));
assert.equal(momDoc.phoneVerifiedKey, digits(M2), "계정 번호와 확인 필드를 함께");
assert.ok(momDoc.phoneVerifiedAt);
assert.equal(momDoc.status, "active");
assert.equal(await indexHolder(M2), mom.uid, "색인 이동");
assert.equal((await db.doc(`academies/${A}/parentPhones/${digits(M1)}`).get()).exists, false, "옛 번호 색인 삭제");
const s1g = (await student(s1)).guardians;
assert.equal(s1g.length, 1, "★9 같은 번호 칸 합침");
assert.equal(s1g[0].linkedParentUid, mom.uid);
assert.equal(digits(s1g[0].phone), digits(M2));
assert.equal(s1g[0].relationId, "mother", "연결된 칸 관계 유지");
assert.equal(s1g[0].name, "엄마", "연결된 칸 이름 유지");
assert.equal(s1g[0].isPrimary, true, "대표 넘김");
assert.deepEqual((await student(s1)).guardianPhones, [digits(M2)]);
assert.ok((await student(s2)).parentUids.includes(mom.uid));
assert.ok(await bell(`p-autolink-${mom.uid}-${s2}`), "자동 연결 벨");
const selfBell = await bell(`p-phone-${mom.uid}`);
assert.equal(selfBell.kind, "parent_phone_changed");
assert.equal(selfBell.variant, "self");
assert.equal(JSON.stringify(selfBell).includes(digits(M2)), false, "벨에 전화번호 없음");
// 증표 재사용 거부
await assert.rejects(call("updateParentProfile", { phone: M2, phoneProof: proofM2 }), /만료되었거나/);

// --- 다른 학부모 계정 번호(색인)로는 바꿀 수 없음 ---
const proofTaken = await proofFor(TAKEN, "phone_change");
await assert.rejects(
  call("updateParentProfile", { phone: TAKEN, phoneProof: proofTaken }),
  /다른 학부모 계정으로 등록되어 있어요/,
);
assert.equal(digits((await parentDoc(mom.uid)).phone), digits(M2), "그대로");

// --- 학원이 연결된 칸 번호를 바꿈 → 안내(같은 트랜잭션)·원래 번호로 고치면 항목 삭제 ---
await asOwner();
const editLinked = async (sid, phone, extra = {}) => {
  const st = await student(sid);
  const guardians = st.guardians.map((g) => ({
    id: g.id, relationId: g.relationId, name: g.name, phone: g.linkedParentUid === mom.uid ? phone : g.phone,
    isPrimary: g.isPrimary,
  }));
  return call("saveStudent", { academyId: A, studentId: sid, name: st.name, grade: "e3", status: "enrolled", guardians, ...extra });
};
let r = await editLinked(s1, A1);
assert.equal(r.phoneNoticeCount, 1);
momDoc = await parentDoc(mom.uid);
assert.equal(momDoc.phoneNotice.byStudent[s1].studentName, "첫째");
assert.equal(digits(momDoc.phoneNotice.byStudent[s1].phone), digits(A1));
assert.ok(momDoc.phoneNotice.byStudent[s1].changedAt);
assert.ok((await student(s1)).parentUids.includes(mom.uid), "연결 유지");
r = await editLinked(s1, M2);
assert.equal(r.phoneNoticeCount, 0);
assert.equal((await parentDoc(mom.uid)).phoneNotice?.byStudent?.[s1], undefined, "계정 번호로 고치면 항목 삭제");
// 번호와 무관한 저장은 안내 없음
assert.equal((await call("saveStudent", { academyId: A, studentId: s1, name: "첫째", grade: "e3", status: "enrolled" })).phoneNoticeCount, 0);

// --- [번호를 바꾸지 않았어요] — 계정 번호가 확인된 번호면 되돌림 + 벨 reverted ---
await editLinked(s1, A1);
await asParent(mom.loginId);
assert.deepEqual(await call("resolveParentPhoneNotice", { action: "revert", studentId: s1 }), {
  ok: true, action: "revert", reverted: true,
});
const reverted = (await student(s1)).guardians.find((g) => g.linkedParentUid === mom.uid);
assert.equal(digits(reverted.phone), digits(M2));
assert.equal((await parentDoc(mom.uid)).phoneNotice?.byStudent?.[s1], undefined);
const revBell = await bell(`p-phone-reverted-${mom.uid}-${s1}`);
assert.equal(revBell.variant, "reverted");
assert.equal(revBell.studentName, "첫째");
assert.equal(JSON.stringify(revBell).includes(digits(A1)), false);
await assert.rejects(call("resolveParentPhoneNotice", { action: "revert", studentId: s1 }), /이미 처리된 안내/);

// --- [지금 쓰는 번호 확인하기] — 학원 번호(A2)와 다른 번호(C)로 확인 → 최종값 C·벨 corrected ---
await asOwner();
await editLinked(s2, A2);
await asParent(mom.loginId);
await assert.rejects(
  call("resolveParentPhoneNotice", { action: "confirm", studentId: s2, phone: C }),
  /문자 확인/,
  "증표 필수",
);
const proofC = await proofFor(C, "phone_change");
const conf = await call("resolveParentPhoneNotice", { action: "confirm", studentId: s2, phone: C, phoneProof: proofC });
assert.equal(conf.action, "confirm");
momDoc = await parentDoc(mom.uid);
assert.equal(digits(momDoc.phone), digits(C));
assert.equal(momDoc.phoneVerifiedKey, digits(C));
assert.equal(momDoc.phoneNotice, undefined, "안내 전체 정리");
for (const sid of [s1, s2]) {
  const linkedSlot = (await student(sid)).guardians.find((g) => g.linkedParentUid === mom.uid);
  assert.equal(digits(linkedSlot.phone), digits(C), `연결된 모든 칸(${sid})`);
}
assert.equal(await indexHolder(C), mom.uid);
const corrBell = await bell(`p-phone-corrected-${mom.uid}-${s2}`);
assert.equal(corrBell.variant, "corrected");
assert.equal(corrBell.studentName, "둘째");

// --- 학원 번호(D)와 같은 번호로 확인 → 계정 번호가 바뀐 것이라 벨 self ---
await asOwner();
await editLinked(s1, D);
await asParent(mom.loginId);
await call("resolveParentPhoneNotice", { action: "confirm", studentId: s1, phone: D, phoneProof: await proofFor(D, "phone_change") });
assert.equal(digits((await parentDoc(mom.uid)).phone), digits(D));
assert.equal((await bell(`p-phone-${mom.uid}`)).variant, "self");
assert.equal((await bell(`p-phone-corrected-${mom.uid}-${s1}`)), undefined);
// 안내가 없으면 confirm 거부(증표는 쓰지 않음)
const proofD2 = await proofFor(D, "phone_change");
await assert.rejects(
  call("resolveParentPhoneNotice", { action: "confirm", studentId: s1, phone: D, phoneProof: proofD2 }),
  /이미 처리된 안내/,
);

// --- 번호 확인 안 한 학부모: [번호를 바꾸지 않았어요] 거부, 원장 연결 후 같은 번호 확인 → 확인 표시 ---
const dad = await parentSignup("phonedad", "아빠", F, false);
await asOwner();
const s3 = await mk("셋째", [{ relationId: "father", phone: F }]);
await call("linkParentToStudents", { academyId: A, parentUid: dad.uid, studentIds: [s3] });
const st3 = await student(s3);
await call("saveStudent", {
  academyId: A, studentId: s3, name: "셋째", grade: "e3", status: "enrolled",
  guardians: st3.guardians.map((g) => ({ id: g.id, relationId: g.relationId, name: g.name, phone: A1, isPrimary: g.isPrimary })),
});
await asParent(dad.loginId);
assert.ok((await parentDoc(dad.uid)).phoneNotice.byStudent[s3]);
await assert.rejects(
  call("resolveParentPhoneNotice", { action: "revert", studentId: s3 }),
  /문자로 확인된 번호일 때만/,
);
await assert.rejects(call("resolveParentPhoneNotice", { action: "nope", studentId: s3 }), /올바르지 않습니다/);
// 같은 번호(F)를 나중에 확인 — 번호는 그대로, 확인 표시만
const sameRes = await call("updateParentProfile", { phone: F, phoneProof: await proofFor(F, "phone_change") });
assert.equal(sameRes.phoneVerified, true);
assert.equal((await parentDoc(dad.uid)).phoneVerifiedKey, digits(F));
// 원장 화면 등 다른 역할은 거부
await asOwner();
await assert.rejects(call("resolveParentPhoneNotice", { action: "revert", studentId: s3 }), /학부모 계정만/);

// --- 직원 본인 번호 변경 증표 필수·비우기, 원장이 인사 정보 번호를 바꾸면 확인 해제 ---
const T1 = "010-4200-0001";
const T2 = "010-4200-0002";
const T3 = "010-4200-0003";
await signOut(auth);
await call("registerStaffSignup", {
  token: S, method: "password", displayName: "번호 선생", phone: T1, loginId: "phoneteacher", password: "pw123456",
  consents: CONSENTS, phoneProof: await proofFor(T1, "staff_signup", S),
});
const teacherUid = (await db.doc("attnLoginIndex/phoneteacher").get()).get("authUid");
await asOwner();
await call("activateTeacher", { academyId: A, teacherAuthUid: teacherUid });
const staffDoc = async () => (await db.doc(`academies/${A}/staff/${teacherUid}`).get()).data();
assert.equal((await staffDoc()).phoneVerifiedKey, digits(T1));
const asTeacher = async () => {
  await signOut(auth);
  await signInWithCustomToken(auth, (await call("signInTeacher", { loginId: "phoneteacher", password: "pw123456" })).customToken);
};
await asTeacher();
await assert.rejects(call("updateTeacherProfile", { displayName: "번호 선생", phone: T2 }), /문자 확인/);
const tRes = await call("updateTeacherProfile", { phone: T2, phoneProof: await proofFor(T2, "phone_change") });
assert.equal(tRes.phoneVerified, true);
assert.equal(digits((await staffDoc()).phone), digits(T2));
assert.equal((await staffDoc()).phoneVerifiedKey, digits(T2));
assert.equal((await staffDoc()).displayName, "번호 선생", "이름은 그대로");
// 다른 사람(학부모) 증표는 못 씀
await assert.rejects(call("updateTeacherProfile", { phone: T3, phoneProof: proofD2 }), /만료되었거나|올바르지 않습니다|다릅니다/);
// 비우기 — 증표 없이 되고 확인 필드도 지움
await call("updateTeacherProfile", { displayName: "번호 선생", phone: "" });
let sd = await staffDoc();
assert.equal(sd.phone, null);
assert.equal(sd.phoneVerifiedKey, undefined);
assert.equal(sd.phoneVerifiedAt, undefined);
// 다시 확인 → 원장이 같은 번호로 저장하면 유지, 다른 번호로 고치면 확인 해제
await call("updateTeacherProfile", { phone: T3, phoneProof: await proofFor(T3, "phone_change") });
await asOwner();
const hrSave = (phone) =>
  call("saveStaffMember", { academyId: A, staffId: teacherUid, displayName: "번호 선생", phone, employmentStatus: "employed" });
await hrSave(T3);
assert.equal((await staffDoc()).phoneVerifiedKey, digits(T3), "같은 번호면 유지");
await hrSave(T1);
sd = await staffDoc();
assert.equal(digits(sd.phone), digits(T1));
assert.equal(sd.phoneVerifiedKey, undefined, "원장이 바꾼 번호는 확인 안 됨");
assert.equal(sd.phoneVerifiedAt, undefined);

console.log("SMOKE OK phone-change");
process.exit(0);
