/**
 * 2-M 원생 여러 명 입력 표(`src/lib/student-bulk.ts`)·직원 미리 등록 표(`src/lib/staff-bulk.ts`) 단위 테스트 — `npm test`(빌드 후 lib/ 대상)
 * 붙여 넣기 해석(탭·줄바꿈·따옴표 칸·머리글)·학년 해석·줄 검사·화면/서버 파일 비교.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BULK_MSG,
  bulkDuplicateKey,
  bulkInTableDuplicates,
  detectPastedHeader,
  emptyBulkStudentDraft,
  MAX_BULK_STUDENTS,
  normalizeBulkPhone,
  parseGradeText,
  parsePastedTable,
  pastedTextToDrafts,
  resolveBulkClass,
  resolveBulkStudentDraft,
  validateBulkStudentInput,
} from "../lib/lib/student-bulk.js";
import {
  BULK_STAFF_MSG,
  bulkStaffDuplicatePhones,
  staffPhoneConflict,
  validateBulkStaffInput,
} from "../lib/lib/staff-bulk.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, p), "utf8").replace(/\r\n/g, "\n");

describe("붙여 넣기 해석", () => {
  it("탭·CRLF·LF·CR, 칸 앞뒤 공백, 끝·빈 줄 버림", () => {
    assert.deepEqual(parsePastedTable("김가나\t초3 \r\n 이다라\t중1\n\n박마바\t고2\r"), [
      ["김가나", "초3"],
      ["이다라", "중1"],
      ["박마바", "고2"],
    ]);
    assert.deepEqual(parsePastedTable("\t\t\n"), []);
    assert.deepEqual(parsePastedTable(""), []);
  });

  it("따옴표 칸 — 안의 줄바꿈·탭, \"\" = \"", () => {
    assert.deepEqual(parsePastedTable("\"김\n가나\"\t\"초\"\"3\"\"\"\n이\t\"a\tb\""), [
      ["김\n가나", "초\"3\""],
      ["이", "a\tb"],
    ]);
    // 닫히지 않은 따옴표는 그냥 글자
    assert.deepEqual(parsePastedTable("\"김\t초3"), [["\"김", "초3"]]);
  });

  it("머리글 인식 — 낱말 칸 2개 이상·번호 칸 없음, 순서·모르는 칸", () => {
    const h = detectPastedHeader(["학년", "학생 이름", "메모", "보호자1 연락처", "반"]);
    assert.deepEqual(h.columns, ["grade", "name", null, "g1Phone", "className"]);
    assert.deepEqual(h.ignored, ["메모"]);
    assert.equal(detectPastedHeader(["김가나", "초3"]), null, "낱말 1개 이하");
    assert.equal(detectPastedHeader(["이름", "010-1234-5678"]), null, "번호 칸이 있으면 머리글 아님");
  });

  it("머리글이 있으면 이름으로 칸 맞춤, 없으면 붙여 넣은 칸부터 고정 순서", () => {
    const withHeader = pastedTextToDrafts("학년\t이름\t연락처\n초3\t김가나\t01012345678", { startColumn: 4 });
    assert.equal(withHeader.headerDetected, true);
    assert.equal(withHeader.drafts.length, 1);
    assert.equal(withHeader.drafts[0].name, "김가나");
    assert.equal(withHeader.drafts[0].grade, "초3");
    assert.equal(withHeader.drafts[0].g1Phone, "01012345678");

    const fromPhone = pastedTextToDrafts("01011112222\t아버지\t01033334444", { startColumn: 4 });
    assert.equal(fromPhone.headerDetected, false);
    assert.equal(fromPhone.drafts[0].g1Phone, "01011112222");
    assert.equal(fromPhone.drafts[0].g2Relation, "아버지");
    assert.equal(fromPhone.drafts[0].g2Phone, "01033334444");

    const full = pastedTextToDrafts("김가나\t초3\t가나초\t어머니\t010-1111-2222\t\t\t수학A");
    assert.deepEqual(full.drafts[0], {
      name: "김가나", grade: "초3", school: "가나초", g1Relation: "어머니", g1Phone: "010-1111-2222",
      g2Relation: "", g2Phone: "", className: "수학A",
    });
  });

  it("200줄까지만, 넘은 줄 수", () => {
    const text = Array.from({ length: 205 }, (_, i) => `학생${i}\t초3`).join("\n");
    const r = pastedTextToDrafts(text);
    assert.equal(r.drafts.length, MAX_BULK_STUDENTS);
    assert.equal(r.droppedCount, 5);
  });
});

describe("학년 해석(★3)", () => {
  const cases = [
    ["초1", "e1"], ["초등 3", "e3"], ["초등학교 6학년", "e6"], ["초교2", "e2"], ["중1", "m1"], ["중학교 3학년", "m3"],
    ["고2", "h2"], ["고등 3학년", "h3"], ["고교1", "h1"], ["미취학", "preschool"], ["유치원", "preschool"], ["유치", "preschool"],
    ["성인", "adult"], ["성인·기타", "adult"], ["기타", "adult"], ["일반", "adult"], ["e4", "e4"], [" 중 2 ", "m2"],
  ];
  for (const [raw, code] of cases) {
    it(`${raw} → ${code}`, () => assert.equal(parseGradeText(raw), code));
  }
  for (const raw of ["졸업", "1학년", "초7", "중4", "고0", "대1", "", "3"]) {
    it(`${raw || "(빈 값)"} → 알 수 없음`, () => assert.equal(parseGradeText(raw), null));
  }
});

describe("번호 정규화", () => {
  it("숫자만·+82·10~11자리·01로 시작", () => {
    assert.equal(normalizeBulkPhone("01012345678"), "010-1234-5678");
    assert.equal(normalizeBulkPhone("+82 10-1234-5678"), "010-1234-5678");
    assert.equal(normalizeBulkPhone("011-123-4567"), "011-123-4567");
    assert.equal(normalizeBulkPhone("02-123-4567"), null);
    assert.equal(normalizeBulkPhone("010-1234"), null);
  });
});

describe("줄 검사", () => {
  const relations = [{ id: "r_mom", label: "어머니" }, { id: "r_dad", label: "아버지" }];
  const classes = [
    { id: "c1", name: "수학A", status: "active" },
    { id: "c2", name: "영어", status: "active" },
    { id: "c3", name: "영어", status: "preparing" },
    { id: "c4", name: "과학", status: "ended" },
  ];
  const ctx = { rowKey: "r1", relations, classes, canAssignClass: true, allowDuplicate: false };
  const draft = (patch) => ({ ...emptyBulkStudentDraft(), name: "김가나", grade: "초3", ...patch });
  const fields = (r) => r.errors.map((e) => `${e.field}:${e.message}`);

  it("정상 줄 → 서버 값", () => {
    const r = resolveBulkStudentDraft(
      draft({ school: "가나초", g1Relation: "어머니", g1Phone: "01011112222", g2Phone: "010-3333-4444", className: "수학A" }),
      ctx,
    );
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.input, {
      rowKey: "r1", name: "김가나", grade: "e3", school: "가나초",
      guardians: [{ relationId: "r_mom", phone: "010-1111-2222" }, { relationId: null, phone: "010-3333-4444" }],
      classId: "c1", allowDuplicate: false,
    });
  });

  it("이름·학년 필수·길이, 학교 길이", () => {
    assert.deepEqual(fields(resolveBulkStudentDraft(draft({ name: " " }), ctx)), [`name:${BULK_MSG.nameRequired}`]);
    assert.deepEqual(fields(resolveBulkStudentDraft(draft({ name: "가".repeat(41) }), ctx)), [`name:${BULK_MSG.nameTooLong}`]);
    assert.deepEqual(fields(resolveBulkStudentDraft(draft({ grade: "" }), ctx)), [`grade:${BULK_MSG.gradeRequired}`]);
    assert.deepEqual(fields(resolveBulkStudentDraft(draft({ grade: "졸업" }), ctx)), [`grade:${BULK_MSG.gradeUnknown}`]);
    assert.deepEqual(fields(resolveBulkStudentDraft(draft({ school: "가".repeat(41) }), ctx)), [`school:${BULK_MSG.schoolTooLong}`]);
  });

  it("번호 형식·관계만·관계 모름·같은 번호 두 번", () => {
    assert.deepEqual(fields(resolveBulkStudentDraft(draft({ g1Phone: "02-123-4567" }), ctx)), [`g1Phone:${BULK_MSG.phoneFormat(1)}`]);
    assert.deepEqual(fields(resolveBulkStudentDraft(draft({ g2Relation: "아버지" }), ctx)), [`g2Phone:${BULK_MSG.phoneMissing(2)}`]);
    assert.deepEqual(
      fields(resolveBulkStudentDraft(draft({ g1Relation: "외삼촌", g1Phone: "01011112222" }), ctx)),
      [`g1Relation:${BULK_MSG.relationUnknown("외삼촌")}`],
    );
    assert.deepEqual(
      fields(resolveBulkStudentDraft(draft({ g1Phone: "01011112222", g2Phone: "010-1111-2222" }), ctx)),
      [`g2Phone:${BULK_MSG.samePhoneTwice}`],
    );
  });

  it("반 — 없음·같은 이름 여러 개·종강·권한 없음", () => {
    assert.deepEqual(fields(resolveBulkStudentDraft(draft({ className: "국어" }), ctx)), [`className:${BULK_MSG.classMissing("국어")}`]);
    assert.deepEqual(fields(resolveBulkStudentDraft(draft({ className: "영어" }), ctx)), [`className:${BULK_MSG.classAmbiguous}`]);
    assert.deepEqual(fields(resolveBulkStudentDraft(draft({ className: "과학" }), ctx)), [`className:${BULK_MSG.classEnded}`]);
    assert.deepEqual(
      fields(resolveBulkStudentDraft(draft({ className: "수학A" }), { ...ctx, canAssignClass: false })),
      [`className:${BULK_MSG.classNoPermission}`],
    );
    assert.deepEqual(resolveBulkClass(" 수학A ", classes), { classId: "c1" });
  });

  it("서버 값 검사 — 지운 관계·없는 반·종강 반·권한·보호자 3명", () => {
    const base = { name: "김가나", grade: "e3", school: "", guardians: [], classId: null };
    const v = (patch, c = {}) =>
      validateBulkStudentInput({ ...base, ...patch }, { relationIds: new Set(["r_mom"]), classes, canAssignClass: true, ...c })
        .map((e) => e.message);
    assert.deepEqual(v({}), []);
    assert.deepEqual(v({ grade: "x9" }), [BULK_MSG.gradeUnknown]);
    assert.deepEqual(v({ guardians: [{ relationId: "r_old", phone: "01011112222" }] }), [BULK_MSG.relationGone]);
    assert.deepEqual(v({ classId: "zz" }), [BULK_MSG.classGone]);
    assert.deepEqual(v({ classId: "c4" }), [BULK_MSG.classEnded]);
    assert.deepEqual(v({ classId: "c1" }, { canAssignClass: false }), [BULK_MSG.classNoPermission]);
    assert.ok(
      v({ guardians: [1, 2, 3].map((i) => ({ relationId: null, phone: `0101111000${i}` })) }).includes("보호자는 두 명까지 입력할 수 있어요."),
    );
  });

  it("동명이인 키·표 안 중복", () => {
    assert.equal(bulkDuplicateKey(" 김가나 ", "e3"), "김가나|e3");
    assert.deepEqual([...bulkInTableDuplicates(["a|e3", "b|e3", "a|e3", null, "b|e4"])].sort(), [0, 2]);
  });
});

describe("직원 미리 등록 표", () => {
  it("이름·번호 검사", () => {
    assert.deepEqual(validateBulkStaffInput({ displayName: "김선생", phone: "010-1234-5678" }), []);
    assert.deepEqual(validateBulkStaffInput({ displayName: "", phone: "" }).map((e) => e.message), [
      BULK_STAFF_MSG.nameRequired,
      BULK_STAFF_MSG.phoneRequired,
    ]);
    assert.deepEqual(validateBulkStaffInput({ displayName: "가".repeat(61), phone: "02-1234-5678" }).map((e) => e.message), [
      BULK_STAFF_MSG.nameTooLong,
      BULK_STAFF_MSG.phoneFormat,
    ]);
  });

  it("표 안 같은 번호(형식 달라도 같은 번호)", () => {
    assert.deepEqual([...bulkStaffDuplicatePhones(["010-1111-2222", "01033334444", "+82 10 1111 2222", ""])].sort(), [0, 2]);
  });

  it("기존 직원 번호 겹침 — 미리 등록 > 계정, 퇴사·게스트 제외", () => {
    const rows = [
      { status: "active", employmentStatus: "employed", isGuest: false, phone: "010-1111-2222" },
      { status: "no_account", employmentStatus: "resigned", isGuest: false, phone: "010-3333-4444" },
      { status: "active", employmentStatus: "employed", isGuest: true, phone: "010-5555-6666" },
      { status: "no_account", employmentStatus: "employed", isGuest: false, phone: "010-7777-8888" },
      { status: "active", employmentStatus: "employed", isGuest: false, phone: "010-7777-8888" },
    ];
    assert.equal(staffPhoneConflict(rows, "01011112222"), "account");
    assert.equal(staffPhoneConflict(rows, "010-3333-4444"), null);
    assert.equal(staffPhoneConflict(rows, "010-5555-6666"), null);
    assert.equal(staffPhoneConflict(rows, "010-7777-8888"), "pre_registered");
    assert.equal(staffPhoneConflict(rows, "010-9999-0000"), null);
  });
});

describe("화면·서버 파일이 같은 내용", () => {
  it("student-bulk.ts", () => {
    assert.equal(read("../src/lib/student-bulk.ts"), read("../../src/lib/academy/student-bulk.ts"));
  });
  it("staff-bulk.ts", () => {
    assert.equal(read("../src/lib/staff-bulk.ts"), read("../../src/lib/academy/staff-bulk.ts"));
  });
});
