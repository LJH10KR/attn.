/**
 * 2-L 학부모 자동 연결 판단 단위 테스트 — 후보 조건(★7)·새 보호자 번호(★3)·벨 결정 ID
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  autoLinkBellId,
  autoLinkCandidateReason,
  isAutoLinkAccountStatus,
  newGuardianPhoneKeys,
} from "../lib/lib/parent-auto-link.js";
import { declineBellId } from "../lib/parent-self-service.js";
import { staffAutoActivatedBellId } from "../lib/staff-signup.js";

describe("자동 연결 후보(★7)", () => {
  it("색인 없음·다른 확인 계정 없음 → ok", () => {
    assert.equal(autoLinkCandidateReason({ parentUid: "p1", indexHolderUid: null, otherVerifiedStatuses: [] }), "ok");
  });
  it("색인을 본인이 잡고 있으면 ok, 다른 계정이면 index_taken", () => {
    assert.equal(autoLinkCandidateReason({ parentUid: "p1", indexHolderUid: "p1", otherVerifiedStatuses: [] }), "ok");
    assert.equal(autoLinkCandidateReason({ parentUid: "p1", indexHolderUid: "p2", otherVerifiedStatuses: [] }), "index_taken");
  });
  it("같은 번호로 확인한 다른 대기·사용 중 계정 → ambiguous, 비활성·첫 로그인 전은 셈하지 않음", () => {
    assert.equal(
      autoLinkCandidateReason({ parentUid: "p1", indexHolderUid: null, otherVerifiedStatuses: ["pending_approval"] }),
      "ambiguous",
    );
    assert.equal(autoLinkCandidateReason({ parentUid: "p1", indexHolderUid: null, otherVerifiedStatuses: ["active"] }), "ambiguous");
    assert.equal(
      autoLinkCandidateReason({ parentUid: "p1", indexHolderUid: null, otherVerifiedStatuses: ["inactive", "pending_setup"] }),
      "ok",
    );
  });
  it("자동 연결 대상 계정 상태", () => {
    assert.equal(isAutoLinkAccountStatus("pending_approval"), true);
    assert.equal(isAutoLinkAccountStatus("active"), true);
    for (const s of ["pending_setup", "inactive", "pending_email_verification", undefined]) {
      assert.equal(isAutoLinkAccountStatus(s), false, String(s));
    }
  });
});

describe("새로 생긴 보호자 번호(★3)", () => {
  it("추가된 번호만, 정렬·중복 없음", () => {
    assert.deepEqual(newGuardianPhoneKeys(["01011112222"], ["01033334444", "01011112222"]), ["01033334444"]);
    assert.deepEqual(newGuardianPhoneKeys(undefined, ["01033334444", "01011112222"]), ["01011112222", "01033334444"]);
  });
  it("연결만 바뀌어 번호 목록이 같으면 빈 목록(트리거 루프 없음)", () => {
    assert.deepEqual(newGuardianPhoneKeys(["01011112222"], ["01011112222"]), []);
  });
  it("번호를 지우기만 하면 빈 목록", () => {
    assert.deepEqual(newGuardianPhoneKeys(["01011112222", "01033334444"], ["01011112222"]), []);
  });
});

describe("원장 벨 결정 ID", () => {
  it("학부모·원생 조합(재시도해도 같은 ID)", () => {
    assert.equal(autoLinkBellId("p1", "s1"), "p-autolink-p1-s1");
    assert.equal(autoLinkBellId("p1", "s1"), autoLinkBellId("p1", "s1"));
    assert.equal(declineBellId("p1", "s1"), "p-decline-p1-s1");
    assert.equal(staffAutoActivatedBellId("u1"), "s-autoact-u1");
  });
});
