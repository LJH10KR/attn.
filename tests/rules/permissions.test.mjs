/**
 * firestore.rules 세부 권한 테스트 — `npm run test:rules` (Firestore 에뮬레이터에서 실행)
 *
 * 원장(ownerUid)은 모든 권한, 직원은 직원 문서 `permissions`만큼,
 * 비활성 직원·무관한 계정·폐지된 포털 토큰은 거부되는지 확인한다.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";

const ACADEMY = "o1_a1";
const OWNER = "owner-uid";
/** 연결된 활성 학부모 — STUDENT·SIBLING의 보호자 */
const PARENT = "parent-uid";
/** 가입 후 승인 대기(연결 없음) */
const PARENT_PENDING = "parent-pending";
/** 비활성화됐지만 아직 STUDENT의 parentUids에 남아 있는 학부모 */
const PARENT_INACTIVE = "parent-inactive";
/** 직접 만든 계정, 첫 로그인 전(연결은 됨) */
const PARENT_SETUP = "parent-setup";
const STUDENT = "student-1";
const SIBLING = "student-2";
/** 아무 학부모와도 연결되지 않은 원생 */
const OTHER_STUDENT = "student-3";

/** 직원 uid → [상태, 권한] */
const STAFF = {
  "staff-students": ["active", ["operations.students"]],
  "staff-parents": ["active", ["operations.parents"]],
  "staff-classes": ["active", ["operations.classes"]],
  "staff-billing": ["active", ["billing.invoices"]],
  "staff-attendance": ["active", ["lessons.attendance"]],
  "staff-members": ["active", ["settings.members"]],
  "staff-payments": ["active", ["billing.payments"]],
  "staff-refunds": ["active", ["billing.refunds"]],
  "staff-hr": ["active", ["settings.staff"]],
  "staff-teacher": ["active", []],
  "staff-inactive": ["inactive", ["operations.students", "settings.members"]],
};

let testEnv;

function dbAs(uid, claims) {
  return testEnv.authenticatedContext(uid, claims).firestore();
}

const academyPath = (...segments) => ["academies", ACADEMY, ...segments].join("/");

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
    await setDoc(doc(db, academyPath()), { ownerUid: OWNER, name: "테스트 학원" });
    for (const [uid, [status, permissions]] of Object.entries(STAFF)) {
      await setDoc(doc(db, academyPath("staff", uid)), {
        authUid: uid,
        displayName: uid,
        status,
        roleId: "custom",
        permissions,
      });
    }
    for (const [uid, status] of [
      [PARENT, "active"],
      [PARENT_PENDING, "pending_approval"],
      [PARENT_INACTIVE, "inactive"],
      [PARENT_SETUP, "pending_setup"],
    ]) {
      await setDoc(doc(db, academyPath("parents", uid)), { authUid: uid, status });
    }
    const student = (parentUids, extra = {}) => ({
      name: "학생",
      grade: "e3",
      gradeYear: 2026,
      status: "enrolled",
      guardians: [],
      guardianPhones: [],
      parentUids,
      classIds: [],
      teacherUids: [],
      tuitionAmount: 100000,
      sessionBalance: 4,
      ...extra,
    });
    // STUDENT는 반 class-a(담당 staff-teacher·비활성 staff-inactive) 학생, OTHER_STUDENT는 다른 반
    await setDoc(
      doc(db, academyPath("students", STUDENT)),
      student([PARENT, PARENT_INACTIVE, PARENT_SETUP], {
        classIds: ["class-a"],
        teacherUids: ["staff-inactive", "staff-teacher"],
      }),
    );
    await setDoc(doc(db, academyPath("students", SIBLING)), student([PARENT]));
    await setDoc(
      doc(db, academyPath("students", OTHER_STUDENT)),
      student([], { classIds: ["class-b"], teacherUids: ["staff-hr"] }),
    );
    await setDoc(doc(db, academyPath("classes", "class-a")), {
      name: "A반", status: "active", schedule: [], teacherUids: ["staff-inactive", "staff-teacher"],
      roomId: null, capacity: null, sortOrder: 0,
    });
    await setDoc(doc(db, academyPath("classes", "class-b")), {
      name: "B반", status: "active", schedule: [], teacherUids: ["staff-hr"],
      roomId: null, capacity: null, sortOrder: 1,
    });
    await setDoc(doc(db, academyPath("classHistory", "h-1")), { classId: "class-a", type: "created" });
    await setDoc(doc(db, academyPath("studentNotes", STUDENT)), { memo: "학원 내부 메모" });
    const paidAt = Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
    await setDoc(doc(db, academyPath("payments", "pay-1")), {
      studentId: STUDENT,
      parentUids: [PARENT, PARENT_INACTIVE],
      amount: 100000,
      status: "PAID",
      createdAt: paidAt,
    });
    // 연결 해제로 parentUids에서 빠진 결제
    await setDoc(doc(db, academyPath("payments", "pay-2")), {
      studentId: OTHER_STUDENT,
      parentUids: [],
      amount: 50000,
      status: "PAID",
      createdAt: paidAt,
    });
    await setDoc(doc(db, academyPath("roles", "teacher")), { name: "선생님", permissions: [] });
  });
});

describe("원장·폐지된 포털 세션", () => {
  it("원장은 학생·결제·역할을 읽는다", async () => {
    const db = dbAs(OWNER);
    await assertSucceeds(getDocs(collection(db, academyPath("students"))));
    await assertSucceeds(getDoc(doc(db, academyPath("payments", "pay-1"))));
    await assertSucceeds(getDocs(collection(db, academyPath("roles"))));
  });

  it("예전 학원 포털 토큰(role=academy)은 더 이상 아무 권한이 없다", async () => {
    const db = dbAs(`academy_${ACADEMY}`, { role: "academy", academyId: ACADEMY });
    await assertFails(getDoc(doc(db, academyPath())));
    await assertFails(getDocs(collection(db, academyPath("students"))));
    await assertFails(updateDoc(doc(db, academyPath("students", STUDENT)), { name: "변경" }));
  });
});

describe("원생 관리 권한(operations.students)", () => {
  it("학생 목록을 읽고, 원생 정보 생성·수정·삭제는 서버 함수만(클라이언트 거부)", async () => {
    const db = dbAs("staff-students");
    await assertSucceeds(getDocs(collection(db, academyPath("students"))));
    await assertFails(updateDoc(doc(db, academyPath("students", STUDENT)), { name: "새 이름" }));
    await assertFails(
      updateDoc(doc(db, academyPath("students", STUDENT)), { parentUids: ["staff-students"] }),
    );
    await assertFails(setDoc(doc(db, academyPath("students", "new-student")), { name: "새 원생" }));
    await assertFails(deleteDoc(doc(db, academyPath("students", STUDENT))));
    // 원장도 마찬가지
    await assertFails(updateDoc(doc(dbAs(OWNER), academyPath("students", STUDENT)), { name: "x" }));
    await assertFails(setDoc(doc(dbAs(OWNER), academyPath("students", "new-student")), { name: "x" }));
  });

  it("원비·회차 필드는 4단계까지 지금처럼 고친다", async () => {
    const db = dbAs("staff-students");
    await assertSucceeds(
      updateDoc(doc(db, academyPath("students", STUDENT)), { tuitionAmount: 110000 }),
    );
    await assertSucceeds(updateDoc(doc(db, academyPath("students", STUDENT)), { sessionBalance: 2 }));
  });

  it("원생 메모(studentNotes)는 원생 관리 권한만 읽고, 쓰기는 모두 거부", async () => {
    const path = academyPath("studentNotes", STUDENT);
    await assertSucceeds(getDoc(doc(dbAs("staff-students"), path)));
    await assertSucceeds(getDoc(doc(dbAs(OWNER), path)));
    for (const uid of [PARENT, "staff-teacher", "staff-billing", "staff-attendance", "staff-classes"]) {
      await assertFails(getDoc(doc(dbAs(uid), path)));
    }
    for (const uid of [OWNER, "staff-students"]) {
      await assertFails(setDoc(doc(dbAs(uid), path), { memo: "x" }));
    }
  });

  it("결제 내역·역할은 읽지 못한다", async () => {
    const db = dbAs("staff-students");
    await assertFails(getDoc(doc(db, academyPath("payments", "pay-1"))));
    await assertFails(getDocs(collection(db, academyPath("roles"))));
  });
});

describe("반 관리 권한(operations.classes)", () => {
  it("원생 배정을 위해 학생 목록을 읽지만 고치지 못한다", async () => {
    const db = dbAs("staff-classes");
    await assertSucceeds(getDocs(collection(db, academyPath("students"))));
    await assertFails(updateDoc(doc(db, academyPath("students", STUDENT)), { name: "x" }));
    await assertFails(updateDoc(doc(db, academyPath("students", STUDENT)), { tuitionAmount: 1 }));
  });
});

describe("청구서 권한(billing.invoices)", () => {
  it("원비 필드만 고칠 수 있다", async () => {
    const db = dbAs("staff-billing");
    await assertSucceeds(
      updateDoc(doc(db, academyPath("students", STUDENT)), { tuitionAmount: 120000 }),
    );
    await assertFails(updateDoc(doc(db, academyPath("students", STUDENT)), { name: "변경" }));
    await assertFails(
      updateDoc(doc(db, academyPath("students", STUDENT)), { teacherUids: ["staff-billing"] }),
    );
    await assertFails(
      updateDoc(doc(db, academyPath("students", STUDENT)), { parentUids: ["staff-billing"] }),
    );
  });

  it("결석 차감 기본값을 저장한다", async () => {
    const db = dbAs("staff-billing");
    await assertSucceeds(
      setDoc(doc(db, academyPath("meta", "absenceDeductionSettings")), {
        method: "per_day",
        perDayAmount: 10000,
      }),
    );
  });

  it("포트원 채널 키는 원장만 바꾼다", async () => {
    await assertFails(
      setDoc(doc(dbAs("staff-billing"), academyPath("meta", "tuitionSettings")), {
        channelKey: "channel-key-test",
      }),
    );
    await assertSucceeds(
      setDoc(doc(dbAs("staff-billing"), academyPath("meta", "tuitionSettings")), {
        bankName: "은행",
      }),
    );
    await assertSucceeds(
      setDoc(doc(dbAs(OWNER), academyPath("meta", "tuitionSettings")), {
        channelKey: "channel-key-test",
      }),
    );
  });
});

describe("출결 권한(lessons.attendance)", () => {
  it("잔여 회차 차감과 수업 완료 기록만 가능", async () => {
    const db = dbAs("staff-attendance");
    await assertSucceeds(updateDoc(doc(db, academyPath("students", STUDENT)), { sessionBalance: 3 }));
    await assertSucceeds(
      setDoc(doc(db, academyPath("students", STUDENT, "sessionLogs", "log-1")), {
        recordedByUid: "staff-attendance",
        wasExtra: false,
      }),
    );
    await assertFails(
      updateDoc(doc(db, academyPath("students", STUDENT)), { tuitionAmount: 1 }),
    );
  });

  it("키오스크 설정을 읽는다", async () => {
    await assertSucceeds(
      getDoc(doc(dbAs("staff-attendance"), academyPath("meta", "kioskSettings"))),
    );
    await assertFails(getDoc(doc(dbAs("staff-students"), academyPath("meta", "kioskSettings"))));
  });
});

describe("결제 내역 권한(billing.payments)", () => {
  it("결제 내역은 읽지만 쓰지 못한다", async () => {
    const db = dbAs("staff-payments");
    await assertSucceeds(getDoc(doc(db, academyPath("payments", "pay-1"))));
    await assertFails(updateDoc(doc(db, academyPath("payments", "pay-1")), { status: "CANCELLED" }));
  });

  it("환불 권한만 있어도 결제 내역은 읽되, 취소 상태는 클라이언트가 쓰지 못한다", async () => {
    const db = dbAs("staff-refunds");
    await assertSucceeds(getDoc(doc(db, academyPath("payments", "pay-1"))));
    await assertFails(updateDoc(doc(db, academyPath("payments", "pay-1")), { status: "CANCELLED" }));
  });
});

describe("멤버 초대/권한 관리(settings.members)", () => {
  it("역할과 직원 목록을 읽는다", async () => {
    const db = dbAs("staff-members");
    await assertSucceeds(getDocs(collection(db, academyPath("roles"))));
    await assertSucceeds(getDocs(collection(db, academyPath("staff"))));
  });

  it("역할·직원 권한은 클라이언트가 쓰지 못한다(원장 포함)", async () => {
    for (const uid of ["staff-members", OWNER]) {
      const db = dbAs(uid);
      await assertFails(
        setDoc(doc(db, academyPath("roles", "teacher")), { name: "x", permissions: ["settings.members"] }),
      );
      await assertFails(
        updateDoc(doc(db, academyPath("staff", "staff-teacher")), {
          permissions: ["settings.members"],
        }),
      );
    }
  });
});

describe("직원 관리(settings.staff)·선택지 목록", () => {
  it("직원 관리 권한은 직원 목록을 읽지만 직원 문서를 쓰지 못한다", async () => {
    const db = dbAs("staff-hr");
    await assertSucceeds(getDocs(collection(db, academyPath("staff"))));
    await assertFails(
      setDoc(doc(db, academyPath("staff", "new-staff")), { displayName: "x", status: "no_account" }),
    );
  });

  it("직무 등 선택지는 원장·활성 직원이 읽고, 클라이언트는 쓰지 못한다", async () => {
    await assertSucceeds(getDoc(doc(dbAs(OWNER), academyPath("meta", "options"))));
    await assertSucceeds(getDoc(doc(dbAs("staff-teacher"), academyPath("meta", "options"))));
    await assertFails(getDoc(doc(dbAs("staff-inactive"), academyPath("meta", "options"))));
    await assertFails(getDoc(doc(dbAs(PARENT), academyPath("meta", "options"))));
    await assertFails(
      setDoc(doc(dbAs(OWNER), academyPath("meta", "options")), {
        jobTitles: [{ id: "a", label: "강사" }],
      }),
    );
  });

  it("학부모·무관한 계정은 직원 목록을 읽지 못한다", async () => {
    await assertFails(getDocs(collection(dbAs(PARENT), academyPath("staff"))));
    await assertFails(getDocs(collection(dbAs("stranger"), academyPath("staff"))));
  });
});

/** 선생님 담당 학생 목록 쿼리 — 2-F "내 반"이 쓸 형태 */
const taughtQuery = (db, uid) =>
  query(collection(db, academyPath("students")), where("teacherUids", "array-contains", uid));

describe("선생님 — 담당 반 학생(teacherUids)", () => {
  it("권한 없는 활성 선생님은 담당 반 학생을 단건·목록(teacherUids array-contains)으로 읽는다", async () => {
    const db = dbAs("staff-teacher");
    await assertSucceeds(getDoc(doc(db, academyPath("students", STUDENT))));
    const list = await assertSucceeds(getDocs(taughtQuery(db, "staff-teacher")));
    assert.deepEqual(list.docs.map((d) => d.id), [STUDENT]);
  });

  it("다른 반 학생 단건, where 없는 전체 목록, 학생 수정은 거부", async () => {
    const db = dbAs("staff-teacher");
    await assertFails(getDoc(doc(db, academyPath("students", OTHER_STUDENT))));
    await assertFails(getDoc(doc(db, academyPath("students", SIBLING))));
    await assertFails(getDocs(collection(db, academyPath("students"))));
    await assertFails(getDocs(taughtQuery(db, "staff-hr")));
    await assertFails(updateDoc(doc(db, academyPath("students", STUDENT)), { name: "x" }));
    await assertFails(updateDoc(doc(db, academyPath("students", STUDENT)), { teacherUids: [] }));
  });

  it("비활성 선생님은 teacherUids에 있어도 단건·목록 거부", async () => {
    const db = dbAs("staff-inactive");
    await assertFails(getDoc(doc(db, academyPath("students", STUDENT))));
    await assertFails(getDocs(taughtQuery(db, "staff-inactive")));
  });
});

describe("반(classes)·반 변경 이력(classHistory)", () => {
  it("원장·활성 직원(권한 없음 포함)은 반을 읽는다 — 내 반 목록(teacherUids array-contains) 포함", async () => {
    await assertSucceeds(getDocs(collection(dbAs(OWNER), academyPath("classes"))));
    await assertSucceeds(getDocs(collection(dbAs("staff-classes"), academyPath("classes"))));
    await assertSucceeds(getDoc(doc(dbAs("staff-teacher"), academyPath("classes", "class-b"))));
    const mine = await assertSucceeds(
      getDocs(
        query(collection(dbAs("staff-teacher"), academyPath("classes")),
          where("teacherUids", "array-contains", "staff-teacher")),
      ),
    );
    assert.deepEqual(mine.docs.map((d) => d.id), ["class-a"]);
  });

  it("학부모·비활성 직원·무관한 계정은 반을 읽지 못한다", async () => {
    for (const uid of [PARENT, PARENT_PENDING, "staff-inactive", "stranger"]) {
      await assertFails(getDoc(doc(dbAs(uid), academyPath("classes", "class-a"))));
      await assertFails(getDocs(collection(dbAs(uid), academyPath("classes"))));
    }
  });

  it("반은 클라이언트가 쓰지 못한다(원장·반 관리 권한 포함)", async () => {
    for (const uid of [OWNER, "staff-classes"]) {
      const db = dbAs(uid);
      await assertFails(setDoc(doc(db, academyPath("classes", "class-new")), { name: "x", teacherUids: [uid] }));
      await assertFails(updateDoc(doc(db, academyPath("classes", "class-a")), { teacherUids: [uid] }));
      await assertFails(deleteDoc(doc(db, academyPath("classes", "class-a"))));
      // 학생 반 배정 필드도 클라이언트 수정 불가
      await assertFails(updateDoc(doc(db, academyPath("students", STUDENT)), { classIds: [] }));
    }
  });

  it("반 변경 이력은 누구도 읽거나 쓰지 못한다", async () => {
    for (const uid of [OWNER, "staff-classes", "staff-teacher", PARENT]) {
      const db = dbAs(uid);
      await assertFails(getDoc(doc(db, academyPath("classHistory", "h-1"))));
      await assertFails(getDocs(collection(db, academyPath("classHistory"))));
      await assertFails(setDoc(doc(db, academyPath("classHistory", "h-2")), { classId: "class-a" }));
    }
  });
});

describe("권한 없는 직원·비활성·무관한 계정", () => {

  it("본인 멤버 문서(권한 포함)는 읽는다", async () => {
    await assertSucceeds(
      getDoc(doc(dbAs("staff-teacher"), academyPath("staff", "staff-teacher"))),
    );
    await assertFails(
      getDoc(doc(dbAs("staff-teacher"), academyPath("staff", "staff-members"))),
    );
  });

  it("비활성 직원은 권한이 남아 있어도 거부", async () => {
    const db = dbAs("staff-inactive");
    await assertFails(getDocs(collection(db, academyPath("students"))));
    await assertFails(getDocs(collection(db, academyPath("roles"))));
  });

  it("가입 QR 링크(signupLinks 해시 문서·secrets/signupLinks 원문)는 누구도 클라이언트로 읽거나 쓰지 못한다", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "signupLinks", "hash-1"), { academyId: ACADEMY, kind: "parent", enabled: true });
      await setDoc(doc(ctx.firestore(), academyPath("secrets", "signupLinks")), { parent: { token: "t", tokenHash: "hash-1" } });
    });
    for (const who of [OWNER, "staff-members"]) {
      await assertFails(getDoc(doc(dbAs(who), "signupLinks", "hash-1")));
      await assertFails(getDoc(doc(dbAs(who), academyPath("secrets", "signupLinks"))));
      await assertFails(setDoc(doc(dbAs(who), "signupLinks", "hash-2"), { academyId: ACADEMY, kind: "parent", enabled: true }));
    }
    await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore(), "signupLinks", "hash-1")));
  });

  it("번호 확인(2-L) 코드·카운터·원장 동의 기록·자동 연결 설정은 누구도 클라이언트로 읽거나 쓰지 못한다", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "phoneVerifications", "v-1"), { purpose: "parent_signup", phoneKey: "01012345678", code: "123456" });
      await setDoc(doc(ctx.firestore(), "phoneVerificationCounters", "octomo_day_20261109"), { count: 1 });
      await setDoc(doc(ctx.firestore(), "legalConsents", OWNER), { consents: {} });
      await setDoc(doc(ctx.firestore(), academyPath("meta", "parentLinkSettings")), { autoLinkVerifiedParents: true });
    });
    const paths = [
      ["phoneVerifications", "v-1"],
      ["phoneVerificationCounters", "octomo_day_20261109"],
      ["legalConsents", OWNER],
      [academyPath("meta", "parentLinkSettings")],
    ];
    for (const who of [OWNER, "staff-members", "staff-parents", PARENT]) {
      for (const p of paths) {
        await assertFails(getDoc(doc(dbAs(who), ...p)));
        await assertFails(setDoc(doc(dbAs(who), ...p), { x: 1 }));
      }
      await assertFails(getDocs(collection(dbAs(who), "phoneVerifications")));
    }
    const anon = testEnv.unauthenticatedContext().firestore();
    for (const p of paths) await assertFails(getDoc(doc(anon, ...p)));
    // 본인 동의 기록도 클라이언트로는 읽거나 쓰지 못함(서버 함수만)
    await assertFails(setDoc(doc(dbAs(OWNER), "legalConsents", OWNER), { consents: { terms: { version: "x" } } }));
  });

  it("로그인 비밀번호 해시·연속 실패 잠금(secrets/login)은 본인·원장도 읽거나 쓰지 못한다", async () => {
    const path = academyPath("staff", "staff-teacher", "secrets", "login");
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), path), { loginFailures: 3 });
    });
    for (const uid of ["staff-teacher", OWNER, "staff-members"]) {
      await assertFails(getDoc(doc(dbAs(uid), path)));
      await assertFails(setDoc(doc(dbAs(uid), path), { loginFailures: 0 }));
    }
    const parentSecret = academyPath("parents", PARENT, "secrets", "login");
    await assertFails(getDoc(doc(dbAs(PARENT), parentSecret)));
    await assertFails(setDoc(doc(dbAs(PARENT), parentSecret), { loginLockedUntil: null }));
  });

  it("학원과 무관한 계정은 거부", async () => {
    const db = dbAs("stranger");
    await assertFails(getDocs(collection(db, academyPath("students"))));
    await assertFails(getDoc(doc(db, academyPath("payments", "pay-1"))));
  });

  it("학부모는 역할·메모를 못 읽는다", async () => {
    const db = dbAs(PARENT);
    await assertFails(getDocs(collection(db, academyPath("roles"))));
    await assertFails(getDoc(doc(db, academyPath("studentNotes", STUDENT))));
  });
});

/** 연결된 자녀 목록 쿼리 — 학부모 앱이 쓰는 형태 그대로 */
const childrenQuery = (db, uid) =>
  query(collection(db, academyPath("students")), where("parentUids", "array-contains", uid));
/** 학부모 결제 내역 쿼리 — `parent-payment-history.tsx`와 같은 형태 */
const paymentsQuery = (db, uid) =>
  query(
    collection(db, academyPath("payments")),
    where("parentUids", "array-contains", uid),
    where("createdAt", ">=", Timestamp.fromMillis(Date.now() - 90 * 24 * 60 * 60 * 1000)),
    orderBy("createdAt", "desc"),
  );

describe("학부모 — 연결된 자녀(parentUids)", () => {
  it("연결된 활성 학부모는 자녀(형제 포함)를 단건·목록으로 읽고 남의 학생은 못 읽는다", async () => {
    const db = dbAs(PARENT);
    await assertSucceeds(getDoc(doc(db, academyPath("students", STUDENT))));
    await assertSucceeds(getDoc(doc(db, academyPath("students", SIBLING))));
    const snap = await assertSucceeds(getDocs(childrenQuery(db, PARENT)));
    if (snap.size !== 2) throw new Error(`형제 2명이어야 함: ${snap.size}`);
    await assertFails(getDoc(doc(db, academyPath("students", OTHER_STUDENT))));
    await assertFails(getDocs(collection(db, academyPath("students"))));
  });

  it("연결 안 된 승인 대기 학부모는 자녀를 못 읽는다(목록은 빈 결과)", async () => {
    const db = dbAs(PARENT_PENDING);
    await assertFails(getDoc(doc(db, academyPath("students", STUDENT))));
    await assertFails(getDocs(collection(db, academyPath("students"))));
    const snap = await assertSucceeds(getDocs(childrenQuery(db, PARENT_PENDING)));
    if (snap.size !== 0) throw new Error("연결 전에는 0명이어야 함");
  });

  it("parentUids에 남아 있어도 비활성·첫 로그인 전 계정은 거부", async () => {
    for (const uid of [PARENT_INACTIVE, PARENT_SETUP]) {
      const db = dbAs(uid);
      await assertFails(getDoc(doc(db, academyPath("students", STUDENT))));
      await assertFails(getDocs(childrenQuery(db, uid)));
    }
  });

  it("학부모 문서가 없는 계정(학원 무관)은 parentUids 쿼리도 거부", async () => {
    await assertFails(getDocs(childrenQuery(dbAs("stranger"), "stranger")));
  });

  it("납부 안내 확인 표시만 고칠 수 있다", async () => {
    const db = dbAs(PARENT);
    await assertSucceeds(
      updateDoc(doc(db, academyPath("students", STUDENT)), {
        tuitionReminderConfirmedAt: serverTimestamp(),
        tuitionReminderConfirmedByUid: PARENT,
      }),
    );
    await assertFails(updateDoc(doc(db, academyPath("students", STUDENT)), { name: "x" }));
    await assertFails(updateDoc(doc(db, academyPath("students", STUDENT)), { tuitionAmount: 0 }));
    await assertFails(
      updateDoc(doc(dbAs(PARENT_PENDING), academyPath("students", STUDENT)), {
        tuitionReminderConfirmedAt: serverTimestamp(),
      }),
    );
  });
});

describe("학부모 — 결제 내역(payments.parentUids)", () => {
  it("연결된 활성 학부모는 결제 목록(array-contains + 기간 + 정렬)과 단건을 읽는다", async () => {
    const db = dbAs(PARENT);
    const snap = await assertSucceeds(getDocs(paymentsQuery(db, PARENT)));
    if (snap.size !== 1) throw new Error(`결제 1건이어야 함: ${snap.size}`);
    await assertSucceeds(getDoc(doc(db, academyPath("payments", "pay-1"))));
    await assertFails(getDoc(doc(db, academyPath("payments", "pay-2"))));
    await assertFails(getDocs(collection(db, academyPath("payments"))));
  });

  it("연결 해제된(parentUids에서 빠진) 학부모는 결제를 못 읽는다", async () => {
    const db = dbAs(PARENT_PENDING);
    await assertFails(getDoc(doc(db, academyPath("payments", "pay-1"))));
    await assertFails(getDocs(collection(db, academyPath("payments"))));
    const snap = await assertSucceeds(getDocs(paymentsQuery(db, PARENT_PENDING)));
    if (snap.size !== 0) throw new Error("해제된 학부모의 결제 목록은 비어야 함");
  });

  it("parentUids에 남아 있어도 비활성 학부모의 결제 목록·단건은 거부", async () => {
    const db = dbAs(PARENT_INACTIVE);
    await assertFails(getDocs(paymentsQuery(db, PARENT_INACTIVE)));
    await assertFails(getDoc(doc(db, academyPath("payments", "pay-1"))));
  });
});

describe("학부모 — 승인 대기 계정·번호 색인(2-C)", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, academyPath("meta", "tuitionSettings")), { bankName: "은행", accountNumber: "123" });
      await setDoc(doc(db, academyPath("parentPhones", "01012345678")), { parentUid: PARENT });
    });
  });

  it("승인 대기 학부모는 본인 계정 문서·학원 문서를 읽고, 납부 계좌(tuitionSettings)는 못 읽는다", async () => {
    const db = dbAs(PARENT_PENDING);
    await assertSucceeds(getDoc(doc(db, academyPath("parents", PARENT_PENDING))));
    await assertSucceeds(getDoc(doc(db, academyPath())));
    await assertFails(getDoc(doc(db, academyPath("meta", "tuitionSettings"))));
    await assertFails(getDoc(doc(db, academyPath("parents", PARENT))));
    await assertFails(updateDoc(doc(db, academyPath("parents", PARENT_PENDING)), { status: "active" }));
    // 연결된 활성 학부모는 납부 계좌를 읽는다
    await assertSucceeds(getDoc(doc(dbAs(PARENT), academyPath("meta", "tuitionSettings"))));
  });

  it("번호 색인(parentPhones)은 원장·학부모 관리 직원·학부모 누구도 읽거나 쓰지 못한다", async () => {
    for (const uid of [OWNER, "staff-parents", PARENT, PARENT_PENDING]) {
      const db = dbAs(uid);
      await assertFails(getDoc(doc(db, academyPath("parentPhones", "01012345678"))));
      await assertFails(getDocs(collection(db, academyPath("parentPhones"))));
      await assertFails(setDoc(doc(db, academyPath("parentPhones", "01099998888")), { parentUid: uid }));
      await assertFails(deleteDoc(doc(db, academyPath("parentPhones", "01012345678"))));
    }
  });

  it("학부모 관리 직원은 학부모 계정 문서를 읽지만 쓰지 못한다", async () => {
    const db = dbAs("staff-parents");
    await assertSucceeds(getDocs(collection(db, academyPath("parents"))));
    await assertFails(updateDoc(doc(db, academyPath("parents", PARENT_PENDING)), { status: "active" }));
  });
});
