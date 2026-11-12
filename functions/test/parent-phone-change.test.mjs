/**
 * 2-L L-3 번호 변경 재확인 단위 테스트 — ★9 칸 합치기, 학원 번호 변경 안내 계산(phoneNotice), 벨 variant·ID
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  changedLinkedGuardianPhones,
  confirmBellVariant,
  MSG_PARENT_PHONE_OTHER_ACCOUNT,
  parentPhoneBellId,
  phoneNoticeActionFor,
  readPhoneNoticeEntry,
  syncLinkedGuardianPhone,
} from "../lib/lib/parent-phone-change.js";

const g = (id, phone, extra = {}) => ({
  id,
  relationId: null,
  name: null,
  phone,
  isPrimary: false,
  linkedParentUid: null,
  ...extra,
});

describe("연결된 칸 번호 동기화·합치기(★9)", () => {
  it("연결된 칸만 새 번호로", () => {
    const r = syncLinkedGuardianPhone(
      [g("g_a", "010-1111-0001", { linkedParentUid: "p1", isPrimary: true }), g("g_b", "010-1111-0002")],
      "p1",
      "010-1111-0009",
    );
    assert.equal(r.changed, true);
    assert.deepEqual(r.guardians.map((x) => [x.id, x.phone]), [["g_a", "010-1111-0009"], ["g_b", "010-1111-0002"]]);
  });

  it("연결된 칸이 없으면 그대로", () => {
    const list = [g("g_a", "010-1111-0001", { linkedParentUid: "other" })];
    const r = syncLinkedGuardianPhone(list, "p1", "010-1111-0009");
    assert.equal(r.changed, false);
    assert.deepEqual(r.guardians, list);
  });

  it("이미 같은 번호면 changed false", () => {
    const r = syncLinkedGuardianPhone([g("g_a", "010-1111-0001", { linkedParentUid: "p1" })], "p1", "010-1111-0001");
    assert.equal(r.changed, false);
  });

  it("같은 번호의 연결 안 된 칸은 합침 — 중복 삭제·관계/이름 채움·대표 넘김", () => {
    const r = syncLinkedGuardianPhone(
      [
        g("g_a", "010-1111-0001", { linkedParentUid: "p1" }),
        g("g_b", "010-1111-0009", { relationId: "mother", name: "엄마", isPrimary: true }),
        g("g_c", "010-1111-0003"),
      ],
      "p1",
      "010-1111-0009",
    );
    assert.equal(r.changed, true);
    assert.equal(r.guardians.length, 2);
    const linked = r.guardians.find((x) => x.id === "g_a");
    assert.equal(linked.phone, "010-1111-0009");
    assert.equal(linked.relationId, "mother");
    assert.equal(linked.name, "엄마");
    assert.equal(linked.isPrimary, true);
    assert.equal(r.guardians.filter((x) => x.isPrimary).length, 1);
    assert.ok(!r.guardians.some((x) => x.id === "g_b"));
  });

  it("연결된 칸에 관계·이름이 있으면 유지", () => {
    const r = syncLinkedGuardianPhone(
      [
        g("g_a", "010-1111-0001", { linkedParentUid: "p1", relationId: "father", name: "아빠", isPrimary: true }),
        g("g_b", "010-1111-0009", { relationId: "mother", name: "엄마" }),
      ],
      "p1",
      "01011110009",
    );
    assert.deepEqual(r.guardians, [
      { ...g("g_a", "01011110009"), linkedParentUid: "p1", relationId: "father", name: "아빠", isPrimary: true },
    ]);
  });

  it("같은 번호 칸이 다른 계정에 연결돼 있으면 거부", () => {
    assert.throws(
      () =>
        syncLinkedGuardianPhone(
          [g("g_a", "010-1111-0001", { linkedParentUid: "p1" }), g("g_b", "010-1111-0009", { linkedParentUid: "p2" })],
          "p1",
          "010-1111-0009",
        ),
      (e) => e.message === MSG_PARENT_PHONE_OTHER_ACCOUNT,
    );
  });
});

describe("학원 번호 변경 안내(phoneNotice)", () => {
  it("학원이 고친 번호가 계정 번호와 같으면 안내 삭제, 다르면 안내", () => {
    assert.equal(phoneNoticeActionFor("010-1111-0001", "01011110001"), "clear");
    assert.equal(phoneNoticeActionFor("010-1111-0001", "010-1111-0002"), "set");
    assert.equal(phoneNoticeActionFor(null, "010-1111-0002"), "set");
    assert.equal(phoneNoticeActionFor("", "010-1111-0002"), "set");
  });

  it("연결된 칸 중 번호가 바뀐 것만(같은 칸 id·같은 계정)", () => {
    const before = [
      g("g_a", "010-1111-0001", { linkedParentUid: "p1" }),
      g("g_b", "010-1111-0002", { linkedParentUid: "p2" }),
      g("g_c", "010-1111-0003"),
    ];
    const after = [
      g("g_a", "010-1111-0011", { linkedParentUid: "p1" }),
      g("g_b", "010-1111-0002", { linkedParentUid: "p2", name: "이름만 바뀜" }),
      g("g_c", "010-1111-0033"),
      g("g_new", "010-1111-0044"),
    ];
    assert.deepEqual(changedLinkedGuardianPhones(before, after), [{ uid: "p1", phone: "010-1111-0011" }]);
  });

  it("안내 항목 읽기", () => {
    assert.deepEqual(readPhoneNoticeEntry({ studentName: "하나", phone: "010-1111-0001", changedAt: 1 }), {
      studentName: "하나",
      phone: "010-1111-0001",
    });
    assert.equal(readPhoneNoticeEntry(undefined), null);
    assert.equal(readPhoneNoticeEntry({ studentName: "x" }), null);
  });
});

describe("벨", () => {
  it("confirm — 학원 번호와 다르면 corrected, 같으면 계정 번호가 바뀐 경우 self", () => {
    assert.equal(confirmBellVariant("010-1111-0002", "010-1111-0003", true), "corrected");
    assert.equal(confirmBellVariant("010-1111-0002", "010-1111-0003", false), "corrected");
    assert.equal(confirmBellVariant("010-1111-0002", "01011110002", true), "self");
    assert.equal(confirmBellVariant("010-1111-0002", "010-1111-0002", false), null);
  });

  it("벨 ID — 본인 변경은 학부모당 1개, 안내 처리는 원생마다", () => {
    assert.equal(parentPhoneBellId("p1", "self"), "p-phone-p1");
    assert.equal(parentPhoneBellId("p1", "corrected", "s1"), "p-phone-corrected-p1-s1");
    assert.equal(parentPhoneBellId("p1", "reverted", "s1"), "p-phone-reverted-p1-s1");
  });
});
