/**
 * 처리방침·약관 본문 구조·토큰·동의 표(2-O) — `npm run test:unit`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LEGAL_DOCUMENTS } from "../../src/content/legal/legal-documents.ts";
import { CONSENT_SUMMARY_ROWS, CONSENT_REFUSAL_NOTE, LEGAL_DOC_VERSIONS } from "../../src/lib/legal/legal-docs.ts";
import {
  EMPTY_LEGAL_INFO,
  fillLegalTokens,
  isLegalInfoField,
  legalTokenKeys,
} from "../../src/lib/legal/legal-info.ts";

const allParagraphs = (kind) => LEGAL_DOCUMENTS[kind].flatMap((s) => s.paragraphs);

describe("본문 구조", () => {
  it("이용약관 = 제1조~제12조 + 부칙(+ 사업자 정보 줄)", () => {
    const headings = LEGAL_DOCUMENTS.terms.map((s) => s.heading).filter(Boolean);
    assert.equal(headings.length, 13);
    headings.slice(0, 12).forEach((h, i) => assert.ok(h.startsWith(`제${i + 1}조 (`), h));
    assert.equal(headings[12], "부칙");
    const last = LEGAL_DOCUMENTS.terms.at(-1);
    assert.equal(last.heading, undefined);
    assert.ok(last.paragraphs[0].startsWith("사업자 정보: 상호 에이티티앤"));
  });

  it("개인정보 처리방침 = 앞 문단 + 1~15번(3-1~3-5는 하위 제목)", () => {
    const top = LEGAL_DOCUMENTS.privacy.filter((s) => s.heading && !s.sub).map((s) => s.heading);
    assert.equal(top.length, 15);
    top.forEach((h, i) => assert.ok(h.startsWith(`${i + 1}. `), h));
    const sub = LEGAL_DOCUMENTS.privacy.filter((s) => s.sub).map((s) => s.heading);
    assert.deepEqual(sub.map((h) => h.split(".")[0]), ["3-1", "3-2", "3-3", "3-4", "3-5"]);
    assert.ok(LEGAL_DOCUMENTS.privacy[0].paragraphs[0].startsWith("에이티티앤(이하 \"회사\")는"));
  });

  it("마크다운 기호·자리 표시·대외 문서 금지어가 남지 않음", () => {
    for (const kind of ["terms", "privacy"]) {
      for (const p of allParagraphs(kind)) {
        for (const bad of ["**", "{{", "}}", "| ", "개발자", "라이선스", "수익 배분", "확정 전"]) {
          assert.ok(!p.includes(bad), `${kind}: "${bad}" in ${p}`);
        }
        assert.ok(p.trim() === p && p.length > 0, `${kind}: 빈 문단·앞뒤 공백`);
      }
    }
  });
});

describe("토큰", () => {
  it("본문 토큰은 모두 알려진 키, 필요한 자리가 다 있음", () => {
    const keys = (kind) => new Set(allParagraphs(kind).flatMap(legalTokenKeys));
    for (const kind of ["terms", "privacy"]) {
      for (const k of keys(kind)) assert.ok(isLegalInfoField(k), `${kind}: [[${k}]]`);
    }
    assert.deepEqual(
      [...keys("privacy")].sort(),
      ["address", "businessNumber", "contactEmail", "privacyEffectiveDate", "representativeName"],
    );
    assert.deepEqual(
      [...keys("terms")].sort(),
      ["address", "businessNumber", "contactEmail", "representativeName", "termsEffectiveDate"],
    );
  });

  it("값이 비어 있거나 읽기 실패여도 채운 본문에 토큰·undefined가 없음", () => {
    for (const kind of ["terms", "privacy"]) {
      for (const status of ["ready", "error", "loading"]) {
        for (const p of allParagraphs(kind)) {
          const out = fillLegalTokens(p, EMPTY_LEGAL_INFO, status);
          for (const bad of ["[[", "]]", "undefined", "null"]) {
            assert.ok(!out.includes(bad), `${kind}/${status}: ${out}`);
          }
        }
      }
    }
    const filled = fillLegalTokens("이 약관은 [[termsEffectiveDate]]부터 시행합니다.", EMPTY_LEGAL_INFO, "ready");
    assert.equal(filled, "이 약관은 (준비 중)부터 시행합니다.");
  });
});

describe("동의 표·버전", () => {
  it("역할마다 2줄, 확정 전 문구 없음, 빈 칸 없음", () => {
    for (const [aud, rows] of Object.entries(CONSENT_SUMMARY_ROWS)) {
      assert.equal(rows.length, 2, aud);
      for (const r of rows) {
        for (const v of [r.items, r.purpose, r.retention]) {
          assert.ok(v && !v.includes("확정 전"), `${aud}: ${v}`);
        }
      }
    }
    assert.equal(CONSENT_REFUSAL_NOTE, "동의를 거부할 수 있으나, 거부하면 회원 가입을 할 수 없습니다.");
  });

  it("확정본 버전", () => {
    assert.deepEqual({ ...LEGAL_DOC_VERSIONS }, { terms: "2026-11-v1", privacy: "2026-11-v1" });
  });
});
