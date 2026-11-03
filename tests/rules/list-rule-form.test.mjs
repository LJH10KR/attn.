/**
 * uid 목록 필드(`parentUids`, 2-D의 `teacherUids`) 규칙 형태 비교 — `npm run test:rules`
 *
 * 1-E에서 선생님 담당 학생 list 쿼리가 OR 평가 오류를 냈으므로, 목록 쿼리(array-contains)가 실제로 통과하는
 * 형태를 고르기 위해 `firestore.rules`의 `uidListHasMe`를 세 가지로 바꿔 같은 시나리오를 돌린다.
 *   in      — `request.auth.uid in list`
 *   hasAny  — `list.hasAny([request.auth.uid])`            (채택 — firestore.rules 그대로)
 *   get     — 호출부를 `resource.data.get('parentUids', [])`로 바꾼 hasAny
 * 형태마다 프로젝트 ID를 달리 써서 다른 규칙 테스트와 섞이지 않게 한다.
 * 결과 표는 docs/stage2-design.md 0장 "바뀐 결정"에 옮겨 적는다(2-D가 같은 형태를 쓴다).
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
  Timestamp,
  where,
} from "firebase/firestore";

const ACADEMY = "o1_a1";
const OWNER = "owner-uid";
const PARENT = "parent-uid";
const ADOPTED = "hasAny";

const baseRules = readFileSync("firestore.rules", "utf8");
const HAS_ANY_BODY = "return list.hasAny([request.auth.uid]);";
const CALL_SITE = "uidListHasMe(resource.data.parentUids)";
assert.ok(baseRules.includes(HAS_ANY_BODY), "uidListHasMe 본문이 바뀌었으면 이 테스트도 맞출 것");
assert.ok(baseRules.includes(CALL_SITE), "uidListHasMe 호출부가 바뀌었으면 이 테스트도 맞출 것");

const FORMS = {
  in: baseRules.replace(HAS_ANY_BODY, "return request.auth.uid in list;"),
  hasAny: baseRules,
  get: baseRules.replaceAll(CALL_SITE, "uidListHasMe(resource.data.get('parentUids', []))"),
};

const academyPath = (...segments) => ["academies", ACADEMY, ...segments].join("/");

async function outcome(promise) {
  try {
    await promise;
    return "허용";
  } catch (e) {
    return e?.code === "permission-denied" ? "거부" : `오류(${e?.code ?? e})`;
  }
}

/** 형태 하나로 시나리오 실행 — 기대값과 실제 결과 */
async function runForm(form, rules) {
  const env = await initializeTestEnvironment({
    projectId: `demo-attn-form-${form.toLowerCase()}`,
    firestore: { rules },
  });
  try {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, academyPath()), { ownerUid: OWNER, name: "학원" });
      await setDoc(doc(db, academyPath("staff", "staff-students")), {
        authUid: "staff-students", status: "active", permissions: ["operations.students"],
      });
      await setDoc(doc(db, academyPath("parents", PARENT)), { authUid: PARENT, status: "active" });
      await setDoc(doc(db, academyPath("students", "s1")), { name: "자녀", parentUids: [PARENT] });
      // 서버는 항상 배열을 쓰지만, 필드가 없는 문서가 섞여도 깨지지 않는지 본다
      await setDoc(doc(db, academyPath("students", "s-no-field")), { name: "필드 없음" });
      await setDoc(doc(db, academyPath("payments", "p1")), {
        studentId: "s1", parentUids: [PARENT], status: "PAID", createdAt: Timestamp.now(),
      });
    });
    const as = (uid) => env.authenticatedContext(uid).firestore();
    const parentDb = as(PARENT);
    const since = Timestamp.fromMillis(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const cases = [
      ["학부모 자녀 단건", "허용", getDoc(doc(parentDb, academyPath("students", "s1")))],
      [
        "학부모 자녀 목록(array-contains)",
        "허용",
        getDocs(query(collection(parentDb, academyPath("students")), where("parentUids", "array-contains", PARENT))),
      ],
      [
        "학부모 결제 목록(array-contains+기간+정렬)",
        "허용",
        getDocs(query(
          collection(parentDb, academyPath("payments")),
          where("parentUids", "array-contains", PARENT),
          where("createdAt", ">=", since),
          orderBy("createdAt", "desc"),
        )),
      ],
      ["필드 없는 문서 학부모 단건", "거부", getDoc(doc(parentDb, academyPath("students", "s-no-field")))],
      ["원장 전체 목록(필드 없는 문서 포함)", "허용", getDocs(collection(as(OWNER), academyPath("students")))],
      [
        "원생 권한 직원 전체 목록(필드 없는 문서 포함)",
        "허용",
        getDocs(collection(as("staff-students"), academyPath("students"))),
      ],
    ];
    const results = [];
    for (const [name, expected, promise] of cases) {
      results.push({ name, expected, actual: await outcome(promise) });
    }
    return results;
  } finally {
    await env.cleanup();
  }
}

const table = {};

describe("uid 목록 규칙 형태 비교(parentUids)", () => {
  after(() => {
    console.log("\n[list-rule-form] 형태별 결과");
    console.table(table);
  });

  for (const [form, rules] of Object.entries(FORMS)) {
    it(`형태 ${form}`, async () => {
      const results = await runForm(form, rules);
      for (const r of results) {
        table[r.name] = { ...(table[r.name] ?? { 기대: r.expected }), [form]: r.actual };
      }
      if (form === ADOPTED) {
        for (const r of results) assert.equal(r.actual, r.expected, `${form}: ${r.name}`);
      }
    });
  }
});
