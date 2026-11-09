/**
 * 직원 가입 번호 ↔ 미리 등록한 직원 번호 비교 규칙(2-K) — 화면과 서버가 같은 규칙을 쓴다.
 * 서버 `functions/src/lib/staff-phone-match.ts` ↔ 화면 `src/lib/academy/staff-phone-match.ts`(같은 내용, 단위 테스트가 비교).
 */

/**
 * 비교용 번호 키 — 숫자만 남기고 국가 번호(+82, 82)를 0으로 바꾼다.
 * 휴대폰 번호(01로 시작, 10~11자리)가 아니면 빈 문자열(어떤 번호와도 같지 않음).
 */
export function staffPhoneMatchKey(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("82") && (d.length === 11 || d.length === 12)) {
    d = `0${d.slice(2)}`;
  }
  if (d.length < 10 || d.length > 11 || !d.startsWith("01")) return "";
  return d;
}

/** 두 번호가 같은 휴대폰 번호인지 — 어느 쪽이든 비어 있거나 형식이 틀리면 false */
export function sameStaffPhone(a: unknown, b: unknown): boolean {
  const ka = staffPhoneMatchKey(a);
  return ka !== "" && ka === staffPhoneMatchKey(b);
}

/** 일치 후보가 될 수 있는 직원 문서 — 계정 없음·퇴사 아님·게스트 아님 */
export type StaffMatchCandidateInput = {
  status: unknown;
  employmentStatus: unknown;
  isGuest: unknown;
  phone: unknown;
};

export function isStaffSignupMatchCandidate(row: StaffMatchCandidateInput, signupPhone: unknown): boolean {
  return (
    row.status === "no_account" &&
    row.employmentStatus !== "resigned" &&
    row.isGuest !== true &&
    sameStaffPhone(row.phone, signupPhone)
  );
}
