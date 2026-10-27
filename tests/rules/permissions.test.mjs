/**
 * firestore.rules 세부 권한 테스트 — `npm run test:rules` (Firestore 에뮬레이터에서 실행)
 *
 * 원장(ownerUid)은 모든 권한, 직원은 직원 문서 `permissions`만큼,
 * 비활성 직원·무관한 계정·폐지된 포털 토큰은 거부되는지 확인한다.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";

const ACADEMY = "o1_a1";
const OWNER = "owner-uid";
const PARENT = "parent-uid";
const STUDENT = "student-1";

/** 직원 uid → [상태, 권한] */
const STAFF = {
  "staff-students": ["active", ["operations.students"]],
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
    await setDoc(doc(db, academyPath("parents", PARENT)), { authUid: PARENT, status: "active" });
    await setDoc(doc(db, academyPath("students", STUDENT)), {
      parentUserId: PARENT,
      name: "학생",
      age: 10,
      tuitionAmount: 100000,
      sessionBalance: 4,
      assignedTeacherUids: ["staff-teacher"],
    });
    await setDoc(doc(db, academyPath("payments", "pay-1")), {
      parentUserId: PARENT,
      amount: 100000,
      status: "PAID",
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
  it("학생 목록을 읽고 원생 정보를 고친다", async () => {
    const db = dbAs("staff-students");
    await assertSucceeds(getDocs(collection(db, academyPath("students"))));
    await assertSucceeds(updateDoc(doc(db, academyPath("students", STUDENT)), { name: "새 이름" }));
  });

  it("결제 내역·역할은 읽지 못한다", async () => {
    const db = dbAs("staff-students");
    await assertFails(getDoc(doc(db, academyPath("payments", "pay-1"))));
    await assertFails(getDocs(collection(db, academyPath("roles"))));
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
      updateDoc(doc(db, academyPath("students", STUDENT)), { assignedTeacherUids: [] }),
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

describe("권한 없는 직원·비활성·무관한 계정", () => {
  /**
   * 전담 학생 목록 쿼리(array-contains)는 변경 전 규칙에서도 에뮬레이터 evaluation error가 나서
   * 앱은 `listTeacherAssignedStudents` Callable을 쓴다 — 2단계 `teacherUids` 전환 때 다시 볼 것.
   */
  it("권한 없는 선생님은 전담 학생 단건만 읽는다", async () => {
    const db = dbAs("staff-teacher");
    await assertSucceeds(getDoc(doc(db, academyPath("students", STUDENT))));
    await assertFails(getDocs(collection(db, academyPath("students"))));
    await assertFails(updateDoc(doc(db, academyPath("students", STUDENT)), { name: "x" }));
  });

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

  it("직원 초대 문서(staffInvites)는 누구도 클라이언트로 읽지 못한다", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "staffInvites", "hash-1"), { academyId: ACADEMY });
    });
    await assertFails(getDoc(doc(dbAs(OWNER), "staffInvites", "hash-1")));
    await assertFails(getDoc(doc(dbAs("staff-members"), "staffInvites", "hash-1")));
  });

  it("학원과 무관한 계정은 거부", async () => {
    const db = dbAs("stranger");
    await assertFails(getDocs(collection(db, academyPath("students"))));
    await assertFails(getDoc(doc(db, academyPath("payments", "pay-1"))));
  });

  it("학부모는 자녀·본인 결제만 읽고 역할은 못 읽는다", async () => {
    const db = dbAs(PARENT);
    await assertSucceeds(getDoc(doc(db, academyPath("students", STUDENT))));
    await assertSucceeds(getDoc(doc(db, academyPath("payments", "pay-1"))));
    await assertFails(getDocs(collection(db, academyPath("roles"))));
  });
});
