/**
 * 홈 "시작하기" 체크리스트(2-M, L4-2·M2-1) — 완료·보임 판단(순수 함수).
 * 기록은 `academies/{a}/meta/onboarding`(서버만 씀, 규칙 없음 = 클라이언트 접근 불가).
 * 문서가 없으면(이미 있는 학원 포함) 보인다(★13).
 */

export type OnboardingCounts = {
  classes: number;
  students: number;
  /** 연결된(사용 중) 학부모 계정 */
  linkedParents: number;
  /** 직원(계정·미리 등록, 게스트 제외) */
  staff: number;
};

export type OnboardingRecord = {
  parentLinkShared: boolean;
  noStaff: boolean;
  hidden: boolean;
  reopened: boolean;
};

export type OnboardingView = {
  steps: {
    classes: { done: boolean; count: number };
    students: { done: boolean; count: number };
    parents: { done: boolean; linkedCount: number; shared: boolean };
    staff: { done: boolean; count: number; noStaff: boolean };
  };
  doneCount: number;
  allDone: boolean;
  /** 홈에 카드를 보일지 */
  visible: boolean;
  /** 전체설정 스위치 값("홈에 시작하기 체크리스트 보이기") */
  settingOn: boolean;
};

export const ONBOARDING_ACTIONS = ["parent_link_shared", "no_staff", "undo_no_staff", "hide", "show"] as const;
export type OnboardingAction = (typeof ONBOARDING_ACTIONS)[number];

export function isOnboardingAction(raw: unknown): raw is OnboardingAction {
  return typeof raw === "string" && (ONBOARDING_ACTIONS as readonly string[]).includes(raw);
}

export function onboardingView(counts: OnboardingCounts, rec: OnboardingRecord): OnboardingView {
  const steps = {
    classes: { done: counts.classes > 0, count: counts.classes },
    students: { done: counts.students > 0, count: counts.students },
    parents: {
      done: counts.linkedParents > 0 || rec.parentLinkShared,
      linkedCount: counts.linkedParents,
      shared: rec.parentLinkShared,
    },
    staff: { done: counts.staff > 0 || rec.noStaff, count: counts.staff, noStaff: rec.noStaff },
  };
  const doneCount = [steps.classes, steps.students, steps.parents, steps.staff].filter((s) => s.done).length;
  const allDone = doneCount === 4;
  const visible = !rec.hidden && (!allDone || rec.reopened);
  return { steps, doneCount, allDone, visible, settingOn: visible };
}
