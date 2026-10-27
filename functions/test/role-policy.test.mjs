/**
 * 역할 권한 상승 차단 규칙(`src/lib/role-policy.ts`) 단위 테스트 — `npm test` (빌드 후 lib/ 대상)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  roleAssignViolation,
  roleDeleteViolation,
  roleSaveViolation,
  staffAccountChangeViolation,
} from "../lib/lib/role-policy.js";
import { ROLE_TEMPLATES } from "../lib/lib/permissions.js";

const owner = { kind: "owner" };
/** settings.members + 원생 관리만 가진 직원, 본인 역할은 "custom-members" */
const staff = {
  kind: "staff",
  uid: "staff-1",
  roleId: "custom-members",
  permissions: ["operations.students", "settings.members"],
};

describe("roleSaveViolation", () => {
  it("원장은 어떤 권한이든 만들고 고친다", () => {
    for (const actor of [owner]) {
      assert.equal(
        roleSaveViolation(actor, {
          roleId: "superAdmin",
          currentPermissions: ROLE_TEMPLATES.superAdmin.permissions,
          nextPermissions: ["billing.refunds"],
        }),
        null,
      );
    }
  });

  it("직원은 본인에게 배정된 역할을 고칠 수 없다(권한 자기 상승)", () => {
    assert.notEqual(
      roleSaveViolation(staff, {
        roleId: "custom-members",
        currentPermissions: staff.permissions,
        nextPermissions: [...staff.permissions, "billing.refunds"],
      }),
      null,
    );
    // 권한을 줄이는 수정도 본인 역할이면 거부
    assert.notEqual(
      roleSaveViolation(staff, {
        roleId: "custom-members",
        currentPermissions: staff.permissions,
        nextPermissions: ["settings.members"],
      }),
      null,
    );
  });

  it("직원은 본인 권한을 넘는 역할을 만들 수 없다", () => {
    assert.notEqual(
      roleSaveViolation(staff, {
        roleId: null,
        currentPermissions: null,
        nextPermissions: ["operations.students", "billing.invoices"],
      }),
      null,
    );
    assert.equal(
      roleSaveViolation(staff, {
        roleId: null,
        currentPermissions: null,
        nextPermissions: ["operations.students"],
      }),
      null,
    );
  });

  it("직원은 본인보다 넓은 역할(슈퍼관리자 등)을 고칠 수 없다", () => {
    assert.notEqual(
      roleSaveViolation(staff, {
        roleId: "superAdmin",
        currentPermissions: ROLE_TEMPLATES.superAdmin.permissions,
        nextPermissions: [],
      }),
      null,
    );
  });

  it("직원은 본인 권한 범위 안의 다른 역할을 고칠 수 있다", () => {
    assert.equal(
      roleSaveViolation(staff, {
        roleId: "teacher",
        currentPermissions: [],
        nextPermissions: ["operations.students"],
      }),
      null,
    );
  });
});

describe("roleDeleteViolation", () => {
  it("직원은 본인 역할·더 넓은 역할을 삭제할 수 없다", () => {
    assert.notEqual(
      roleDeleteViolation(staff, { roleId: "custom-members", currentPermissions: [] }),
      null,
    );
    assert.notEqual(
      roleDeleteViolation(staff, {
        roleId: "custom-wide",
        currentPermissions: ["billing.refunds"],
      }),
      null,
    );
    assert.equal(
      roleDeleteViolation(staff, {
        roleId: "custom-narrow",
        currentPermissions: ["operations.students"],
      }),
      null,
    );
  });
});

describe("roleAssignViolation", () => {
  it("직원은 본인 역할을 바꿀 수 없다", () => {
    assert.notEqual(
      roleAssignViolation(staff, {
        staffId: "staff-1",
        staffCurrentPermissions: staff.permissions,
        rolePermissions: [],
      }),
      null,
    );
  });

  it("직원은 본인 권한을 넘는 역할을 다른 직원에게 줄 수 없다", () => {
    assert.notEqual(
      roleAssignViolation(staff, {
        staffId: "staff-2",
        staffCurrentPermissions: [],
        rolePermissions: ROLE_TEMPLATES.superAdmin.permissions,
      }),
      null,
    );
  });

  it("직원은 본인보다 넓은 권한의 직원을 강등할 수 없다", () => {
    assert.notEqual(
      roleAssignViolation(staff, {
        staffId: "staff-2",
        staffCurrentPermissions: ROLE_TEMPLATES.superAdmin.permissions,
        rolePermissions: [],
      }),
      null,
    );
  });

  it("범위 안이면 배정할 수 있고, 원장은 제한 없다", () => {
    assert.equal(
      roleAssignViolation(staff, {
        staffId: "staff-2",
        staffCurrentPermissions: [],
        rolePermissions: ["operations.students"],
      }),
      null,
    );
    assert.equal(
      roleAssignViolation(owner, {
        staffId: "staff-2",
        staffCurrentPermissions: [],
        rolePermissions: ROLE_TEMPLATES.superAdmin.permissions,
      }),
      null,
    );
  });
});

describe("staffAccountChangeViolation (비활성·삭제·임시 비밀번호·퇴사)", () => {
  it("직원은 본인 계정을 바꿀 수 없다", () => {
    assert.notEqual(
      staffAccountChangeViolation(staff, { staffId: "staff-1", staffCurrentPermissions: [] }),
      null,
    );
  });

  it("직원은 본인보다 넓은 권한의 직원 계정을 바꿀 수 없다(계정 탈취 차단)", () => {
    assert.notEqual(
      staffAccountChangeViolation(staff, {
        staffId: "staff-2",
        staffCurrentPermissions: ROLE_TEMPLATES.superAdmin.permissions,
      }),
      null,
    );
  });

  it("범위 안의 직원 계정은 바꿀 수 있고, 원장은 제한 없다", () => {
    assert.equal(
      staffAccountChangeViolation(staff, {
        staffId: "staff-2",
        staffCurrentPermissions: ["operations.students"],
      }),
      null,
    );
    for (const actor of [owner]) {
      assert.equal(
        staffAccountChangeViolation(actor, {
          staffId: "staff-2",
          staffCurrentPermissions: ROLE_TEMPLATES.superAdmin.permissions,
        }),
        null,
      );
    }
  });
});

describe("역할 템플릿", () => {
  it("결제 취소(환불)는 슈퍼관리자 템플릿에만 있다", () => {
    for (const [key, t] of Object.entries(ROLE_TEMPLATES)) {
      assert.equal(t.permissions.includes("billing.refunds"), key === "superAdmin", key);
    }
  });

  it("관리자는 설정 권한이 없고, 행정담당은 운영+수납만", () => {
    assert.ok(!ROLE_TEMPLATES.admin.permissions.some((p) => p.startsWith("settings.")));
    assert.ok(
      ROLE_TEMPLATES.office.permissions.every(
        (p) => p.startsWith("operations.") || p.startsWith("billing."),
      ),
    );
  });
});
