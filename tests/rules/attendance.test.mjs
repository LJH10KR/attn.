/**
 * 2-I 등원 기록(attendanceRecords)·반 출결(attendance) 읽기 규칙 — `npm run test:rules`
 *
 * - 등원 기록: 출결·청구서 권한 + 담당 선생님(학생 teacherUids)
 * - 반 출결: 출결·청구서 권한 + 그 반 선생님(반 teacherUids, `classId ==` 조건 목록 조회)
 * - 쓰기는 모두 서버만
 */
import { after, before, beforeEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
  where,
} from "firebase/firestore";

const ACADEMY = "acad_att";
const OWNER = "owner-uid";
const PARENT = "parent-uid";
const DATE = "2026-11-04";
/** 반 class_a(선생님 t-a), class_b(선생님 t-b) — 문서 ID에 `_`가 들어간 seed 형식도 확인 */
const CLASS_A = "class_a";
const CLASS_B = "class_b";
const S1 = "student_1_1"; // class_a
const S2 = "student_1_2"; // class_b

const STAFF = {
  "t-a": ["active", []],
  "t-b": ["active", []],
  "t-a-inactive": ["inactive", []],
  "staff-attendance": ["active", ["lessons.attendance"]],
  "staff-billing": ["active", ["billing.invoices"]],
  "staff-classes": ["active", ["operations.classes"]],
  "staff-students": ["active", ["operations.students"]],
};

let testEnv;
const dbAs = (uid) => testEnv.authenticatedContext(uid).firestore();
const p = (...segments) => ["academies", ACADEMY, ...segments].join("/");

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "demo-attn",
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
});

after(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, p()), { ownerUid: OWNER, name: "출결 학원" });
    for (const [uid, [status, permissions]] of Object.entries(STAFF)) {
      await setDoc(doc(db, p("staff", uid)), { authUid: uid, status, roleId: "custom", permissions });
    }
    await setDoc(doc(db, p("parents", PARENT)), { authUid: PARENT, status: "active" });
    await setDoc(doc(db, p("classes", CLASS_A)), {
      name: "A반", status: "active", schedule: [], teacherUids: ["t-a", "t-a-inactive"],
    });
    await setDoc(doc(db, p("classes", CLASS_B)), {
      name: "B반", status: "active", schedule: [], teacherUids: ["t-b"],
    });
    const student = (classId, teacherUids) => ({
      name: "학생", status: "enrolled", classIds: [classId], teacherUids, parentUids: [PARENT],
    });
    await setDoc(doc(db, p("students", S1)), student(CLASS_A, ["t-a", "t-a-inactive"]));
    await setDoc(doc(db, p("students", S2)), student(CLASS_B, ["t-b"]));
    for (const [sid, classId] of [[S1, CLASS_A], [S2, CLASS_B]]) {
      await setDoc(doc(db, p("students", sid, "attendanceRecords", DATE)), {
        date: DATE, status: "present", academyId: ACADEMY, studentId: sid,
      });
      await setDoc(doc(db, p("attendance", `${DATE}_${classId}_${sid}`)), {
        academyId: ACADEMY, date: DATE, classId, studentId: sid, status: "present", className: "반",
      });
    }
  });
});

const arrivalRef = (db, sid, date = DATE) => doc(db, p("students", sid, "attendanceRecords", date));
const classListQuery = (db, classId, date = DATE) =>
  query(collection(db, p("attendance")), where("classId", "==", classId), where("date", "==", date));

describe("등원 기록(attendanceRecords)", () => {
  it("원장·출결·청구서 권한은 읽는다", async () => {
    for (const uid of [OWNER, "staff-attendance", "staff-billing"]) {
      await assertSucceeds(getDoc(arrivalRef(dbAs(uid), S1)));
      await assertSucceeds(getDocs(collection(dbAs(uid), p("students", S2, "attendanceRecords"))));
    }
  });

  it("권한 없는 담당 선생님은 담당 학생의 등원 기록을 단건(없는 날짜 포함)·목록으로 읽는다", async () => {
    const db = dbAs("t-a");
    await assertSucceeds(getDoc(arrivalRef(db, S1)));
    await assertSucceeds(getDoc(arrivalRef(db, S1, "2026-11-05")));
    await assertSucceeds(
      getDocs(query(collection(db, p("students", S1, "attendanceRecords")), orderBy("date", "desc"))),
    );
  });

  it("담당이 아닌 선생님·비활성 선생님·반/원생 권한만 직원·학부모는 거부", async () => {
    await assertFails(getDoc(arrivalRef(dbAs("t-b"), S1)));
    await assertFails(getDoc(arrivalRef(dbAs("t-a-inactive"), S1)));
    await assertFails(getDoc(arrivalRef(dbAs("staff-classes"), S1)));
    await assertFails(getDoc(arrivalRef(dbAs("staff-students"), S1)));
    await assertFails(getDoc(arrivalRef(dbAs(PARENT), S1)));
  });

  it("쓰기는 원장 포함 모두 거부", async () => {
    await assertFails(setDoc(arrivalRef(dbAs(OWNER), S1), { date: DATE, status: "absent" }));
    await assertFails(setDoc(arrivalRef(dbAs("t-a"), S1), { date: DATE, status: "absent" }));
  });
});

describe("반 출결(attendance)", () => {
  it("원장·출결·청구서 권한은 전체 목록·학생별 기간 조회·단건을 읽는다", async () => {
    for (const uid of [OWNER, "staff-attendance", "staff-billing"]) {
      const db = dbAs(uid);
      await assertSucceeds(getDocs(query(collection(db, p("attendance")), where("date", "==", DATE))));
      await assertSucceeds(
        getDocs(
          query(
            collection(db, p("attendance")),
            where("studentId", "==", S2),
            where("date", ">=", "2026-11-01"),
            where("date", "<=", "2026-11-30"),
            orderBy("date", "desc"),
          ),
        ),
      );
      await assertSucceeds(getDoc(doc(db, p("attendance", `${DATE}_${CLASS_A}_${S1}`))));
    }
  });

  it("권한 없는 그 반 선생님은 classId == + date == 목록 조회와 있는 문서 단건을 읽는다", async () => {
    const db = dbAs("t-a");
    const snap = await assertSucceeds(getDocs(classListQuery(db, CLASS_A)));
    if (snap.size !== 1) throw new Error(`expected 1, got ${snap.size}`);
    await assertSucceeds(getDocs(classListQuery(db, CLASS_A, "2026-11-05")));
    await assertSucceeds(getDoc(doc(db, p("attendance", `${DATE}_${CLASS_A}_${S1}`))));
  });

  it("다른 반 목록·조건 없는 목록·다른 반 단건·없는 문서 단건은 거부", async () => {
    const db = dbAs("t-a");
    await assertFails(getDocs(classListQuery(db, CLASS_B)));
    await assertFails(getDocs(query(collection(db, p("attendance")), where("date", "==", DATE))));
    await assertFails(getDoc(doc(db, p("attendance", `${DATE}_${CLASS_B}_${S2}`))));
    await assertFails(getDoc(doc(db, p("attendance", `2026-11-05_${CLASS_A}_${S1}`))));
  });

  it("비활성 선생님·반 관리만·원생 관리만 직원·학부모는 거부", async () => {
    await assertFails(getDocs(classListQuery(dbAs("t-a-inactive"), CLASS_A)));
    await assertFails(getDocs(classListQuery(dbAs("staff-classes"), CLASS_A)));
    await assertFails(getDocs(classListQuery(dbAs("staff-students"), CLASS_A)));
    await assertFails(getDocs(classListQuery(dbAs(PARENT), CLASS_A)));
  });

  it("쓰기는 원장·그 반 선생님 포함 모두 거부", async () => {
    const id = `${DATE}_${CLASS_A}_${S1}`;
    await assertFails(setDoc(doc(dbAs(OWNER), p("attendance", id)), { status: "absent", classId: CLASS_A }));
    await assertFails(setDoc(doc(dbAs("t-a"), p("attendance", id)), { status: "absent", classId: CLASS_A }));
  });
});
