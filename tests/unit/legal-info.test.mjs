/**
 * 법적 고지 정보 순수 함수(2-O) — `npm run test:unit`. Node 22 타입 제거로 `.ts`를 바로 불러온다.
 * 형식 사례는 `tests/rules/permissions.test.mjs` "법적 고지 정보"와 같게 유지한다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUSINESS_NAME,
  businessInfoItems,
  DEFAULT_CONTACT_EMAIL,
  EMPTY_LEGAL_INFO,
  fillLegalTokens,
  formatBusinessNumber,
  formatEffectiveDate,
  isValidEffectiveDate,
  LEGAL_INFO_FIELDS,
  legalTokenText,
  missingLegalInfoFields,
  normalizeLegalInfo,
  splitLegalTokens,
  validateLegalInfoInput,
} from "../../src/lib/legal/legal-info.ts";

const FULL = {
  representativeName: "홍길동",
  businessNumber: "123-45-67890",
  address: "서울특별시 어딘가 1",
  contactEmail: "help@example.com",
  privacyEffectiveDate: "2026-12-01",
  termsEffectiveDate: "2027-01-15",
};

describe("정규화", () => {
  it("문서 없음·이상한 타입은 빈 값, 문자열은 다듬음", () => {
    assert.deepEqual(normalizeLegalInfo(null), EMPTY_LEGAL_INFO);
    assert.deepEqual(normalizeLegalInfo(undefined), EMPTY_LEGAL_INFO);
    assert.deepEqual(normalizeLegalInfo("x"), EMPTY_LEGAL_INFO);
    const n = normalizeLegalInfo({ representativeName: "  홍길동 ", businessNumber: 1234, address: null, extra: "x" });
    assert.equal(n.representativeName, "홍길동");
    assert.equal(n.businessNumber, "");
    assert.equal(n.address, "");
    assert.deepEqual(Object.keys(n).sort(), [...LEGAL_INFO_FIELDS].sort());
  });
});

describe("형식", () => {
  it("사업자등록번호 — 숫자 10자리면 하이픈", () => {
    assert.equal(formatBusinessNumber("1234567890"), "123-45-67890");
    assert.equal(formatBusinessNumber("123 45 67890"), "123-45-67890");
    assert.equal(formatBusinessNumber("123-45-67890"), "123-45-67890");
    assert.equal(formatBusinessNumber(" 12345 "), "12345");
  });

  it("시행일 — 실제 날짜만, 한국어 표시", () => {
    assert.equal(isValidEffectiveDate("2026-12-01"), true);
    assert.equal(isValidEffectiveDate("2028-02-29"), true);
    assert.equal(isValidEffectiveDate("2027-02-29"), false);
    assert.equal(isValidEffectiveDate("2026-13-01"), false);
    assert.equal(isValidEffectiveDate("2026/12/01"), false);
    assert.equal(formatEffectiveDate("2026-12-01"), "2026년 12월 1일");
    assert.equal(formatEffectiveDate("2027-01-15"), "2027년 1월 15일");
    assert.equal(formatEffectiveDate(""), "");
    assert.equal(formatEffectiveDate("2026-02-30"), "");
  });
});

describe("관리자 입력 검사(규칙과 같은 사례)", () => {
  it("맞는 값·빈 값은 통과", () => {
    assert.deepEqual(validateLegalInfoInput(FULL), {});
    assert.deepEqual(validateLegalInfoInput(EMPTY_LEGAL_INFO), {});
    assert.deepEqual(validateLegalInfoInput({ ...FULL, contactEmail: "a.b+c@sub.example.co.kr" }), {});
  });

  it("틀린 값은 그 칸만 오류", () => {
    const cases = [
      ["businessNumber", "1234567890"],
      ["businessNumber", "123-45-6789"],
      ["businessNumber", "abc-de-fghij"],
      ["contactEmail", "not-an-email"],
      ["contactEmail", "a b@c.com"],
      ["contactEmail", "a@b"],
      ["privacyEffectiveDate", "2026-13-01"],
      ["privacyEffectiveDate", "2026/12/01"],
      ["termsEffectiveDate", "2026-12-32"],
      ["termsEffectiveDate", "2026-02-30"],
      ["representativeName", "가".repeat(41)],
      ["address", "가".repeat(201)],
      ["contactEmail", `${"a".repeat(115)}@b.com`],
    ];
    for (const [k, v] of cases) {
      const errs = validateLegalInfoInput({ ...FULL, [k]: v });
      assert.deepEqual(Object.keys(errs), [k], `${k}=${v}`);
    }
  });

  it("비어 있는 칸 목록", () => {
    assert.deepEqual(missingLegalInfoFields(FULL), []);
    assert.deepEqual(missingLegalInfoFields(EMPTY_LEGAL_INFO), [...LEGAL_INFO_FIELDS]);
    assert.deepEqual(missingLegalInfoFields({ ...FULL, address: "" }), ["address"]);
  });
});

describe("토큰 채우기", () => {
  const TEXT =
    "대표 [[representativeName]] · 번호 [[businessNumber]] · 주소 [[address]] · 이메일 [[contactEmail]] · [[privacyEffectiveDate]] · [[termsEffectiveDate]]";

  it("값이 있으면 그대로, 날짜는 한국어", () => {
    assert.equal(
      fillLegalTokens(TEXT, FULL, "ready"),
      "대표 홍길동 · 번호 123-45-67890 · 주소 서울특별시 어딘가 1 · 이메일 help@example.com · 2026년 12월 1일 · 2027년 1월 15일",
    );
  });

  it("빈 값·읽기 실패·읽는 중에도 빈칸·undefined·토큰이 나오지 않고, 이메일은 기본값", () => {
    for (const status of ["ready", "error", "loading"]) {
      const out = fillLegalTokens(TEXT, EMPTY_LEGAL_INFO, status);
      for (const bad of ["[[", "]]", "undefined", "null", "{{", "  "]) {
        assert.ok(!out.includes(bad), `${status}: ${bad} in ${out}`);
      }
      assert.ok(out.includes(`이메일 ${DEFAULT_CONTACT_EMAIL}`), out);
    }
    assert.equal(legalTokenText("representativeName", EMPTY_LEGAL_INFO, "ready"), "(준비 중)");
    assert.equal(legalTokenText("privacyEffectiveDate", EMPTY_LEGAL_INFO, "error"), "(준비 중)");
    assert.equal(legalTokenText("address", FULL, "loading"), "…");
  });

  it("모르는 토큰은 글자 그대로(본문 검사에서 걸러짐), 토큰 없는 문단은 한 조각", () => {
    assert.deepEqual(splitLegalTokens("가 [[unknown]] 나"), [{ kind: "text", text: "가 [[unknown]] 나" }]);
    assert.deepEqual(splitLegalTokens("그냥 문단"), [{ kind: "text", text: "그냥 문단" }]);
    assert.deepEqual(splitLegalTokens("[[address]]"), [{ kind: "token", key: "address" }]);
  });
});

describe("하단 사업자 정보", () => {
  it("모두 있으면 상호·대표·사업자등록번호·주소·이메일 순서", () => {
    assert.deepEqual(
      businessInfoItems(FULL).map((i) => i.text),
      [`상호 ${BUSINESS_NAME}`, "대표 홍길동", "사업자등록번호 123-45-67890", "주소 서울특별시 어딘가 1", "이메일 help@example.com"],
    );
  });

  it("빈 값은 빼고, 상호·이메일(기본값)은 항상", () => {
    assert.deepEqual(
      businessInfoItems(EMPTY_LEGAL_INFO).map((i) => i.text),
      [`상호 ${BUSINESS_NAME}`, `이메일 ${DEFAULT_CONTACT_EMAIL}`],
    );
    assert.deepEqual(
      businessInfoItems({ ...EMPTY_LEGAL_INFO, address: "주소 1" }).map((i) => i.key),
      ["name", "address", "contactEmail"],
    );
  });
});
