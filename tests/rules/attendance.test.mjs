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
  collectionGroup,
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

/** 3-A 날짜별 등원 기록(컬렉션 그룹 `academyId ==`·`date ==`) */
const dayArrivalsQuery = (db, academyId = ACADEMY, date = DATE) =>
  query(collectionGroup(db, "attendanceRecords"), where("academyId", "==", academyId), where("date", "==", date));

describe("등원 기록 컬렉션 그룹(3-A)", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "academies/acad_other"), { ownerUid: "other-owner", name: "다른 학원" });
      await setDoc(doc(db, "academies/acad_other/students/sx/attendanceRecords", DATE), {
        date: DATE, status: "present", academyId: "acad_other", studentId: "sx",
      });
    });
  });

  it("원장·출결·청구서 권한은 학원·날짜 목록을 읽는다(그 학원 문서만)", async () => {
    for (const uid of [OWNER, "staff-attendance", "staff-billing"]) {
      const snap = await assertSucceeds(getDocs(dayArrivalsQuery(dbAs(uid))));
      if (snap.size !== 2) throw new Error(`${uid}: expected 2, got ${snap.size}`);
    }
  });

  it("권한 없는 담당 선생님·반 관리만·원생 관리만 직원·학부모·비활성 선생님은 거부", async () => {
    for (const uid of ["t-a", "t-a-inactive", "staff-classes", "staff-students", PARENT]) {
      await assertFails(getDocs(dayArrivalsQuery(dbAs(uid))));
    }
  });

  it("다른 학원 원장은 이 학원 목록 거부, 자기 학원 목록은 허용", async () => {
    await assertFails(getDocs(dayArrivalsQuery(dbAs("other-owner"))));
    await assertSucceeds(getDocs(dayArrivalsQuery(dbAs("other-owner"), "acad_other")));
  });

  it("academyId 조건 없는 목록은 원장도 거부", async () => {
    await assertFails(getDocs(query(collectionGroup(dbAs(OWNER), "attendanceRecords"), where("date", "==", DATE))));
  });
});

describe("정정 이력(attendanceCorrections, 3-A)", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), p("attendanceCorrections", "c1")), {
        academyId: ACADEMY, date: DATE, studentId: S1, layer: "arrival", action: "update",
      });
    });
  });

  it("원장·출결 권한은 단건·날짜 목록을 읽는다", async () => {
    for (const uid of [OWNER, "staff-attendance"]) {
      const db = dbAs(uid);
      await assertSucceeds(getDoc(doc(db, p("attendanceCorrections", "c1"))));
      await assertSucceeds(getDocs(query(collection(db, p("attendanceCorrections")), where("date", "==", DATE))));
    }
  });

  it("청구서만 직원·담당 선생님·반 관리만 직원·학부모는 거부", async () => {
    for (const uid of ["staff-billing", "t-a", "staff-classes", PARENT]) {
      await assertFails(getDoc(doc(dbAs(uid), p("attendanceCorrections", "c1"))));
    }
  });

  it("쓰기는 원장 포함 모두 거부", async () => {
    await assertFails(setDoc(doc(dbAs(OWNER), p("attendanceCorrections", "c2")), { date: DATE }));
    await assertFails(setDoc(doc(dbAs("staff-attendance"), p("attendanceCorrections", "c2")), { date: DATE }));
  });
});
