/**
 * 회원 탈퇴·학원 삭제 화면 문구(2-N) — 처리방침 v2 4·10번, 약관 제9조와 맞춤.
 * 서버 사유 코드(`details.reason`)별 문구도 여기에서.
 */

export type WithdrawalRole = "owner" | "teacher" | "parent";

/** 탈퇴 직후 `/withdrawn`이 로그아웃(푸시 해제 포함)할 때 쓸 역할 — 설정 화면에서 바로 로그아웃하면 그 화면이 로그인 화면으로 먼저 보냄 */
export const WITHDRAWN_ROLE_STORAGE_KEY = "attn_withdrawn_role";

export const WITHDRAWAL_TEXT = {
  cardTitle: "회원 탈퇴",
  intro: "탈퇴하면 이 계정으로 다시 로그인할 수 없고, 되돌릴 수 없어요.",
  membershipsLead: "탈퇴하면 아래 학원 이용도 모두 끝나요.",
  deletedTitle: "지워지는 것",
  keptTitle: "학원에 남는 것",
  deleted: {
    owner: "이름·휴대폰 번호·이메일·비밀번호·Google 연결·알림 설정, 서비스 이용 동의 기록",
    teacher: "이름·휴대폰 번호·로그인 ID·비밀번호·Google 연결·알림 설정",
    parent: "이름·휴대폰 번호·로그인 ID·비밀번호·Google 연결·알림 설정, 자녀 연결",
  } satisfies Record<WithdrawalRole, string>,
  kept: {
    parent: "학원이 적은 원생·보호자 정보(보호자 이름·번호·관계)와 결제 기록은 학원의 기록으로 남아요.",
    teacher: "이름·연락처·직책 같은 인사 기록은 「계정 없음」 직원으로 학원에 남아요.",
  },
  keptOwnerNone: "운영 중인 학원이 없어 학원에 남는 기록은 없어요.",
  keptCommon: "학원 기록의 삭제는 해당 학원에 요청해 주세요.",
  confirmCheck: "위 내용을 확인했어요",
  next: "다음",
  reauthTitle: "본인 확인",
  reauthLead: "탈퇴하려면 본인 확인이 필요해요.",
  passwordLabel: "비밀번호",
  googleButton: "Google로 다시 로그인",
  submit: "탈퇴하기",
  busy: "탈퇴하는 중이에요…",
  partial: "탈퇴를 끝내지 못했어요. [다시 시도]를 누르면 이어서 처리해요.",
  retry: "다시 시도",
  reauthExpired: "본인 확인 시간이 지났어요. 다시 확인해 주세요.",
  wrongPassword: "비밀번호가 올바르지 않습니다.",
  googleMismatch: "로그인한 계정과 다른 Google 계정이에요. 같은 계정으로 다시 로그인해 주세요.",
  popupClosed: "Google 로그인 창이 닫혔어요. 다시 시도해 주세요.",
  blockedOwner: "운영 중인 학원이 있어 탈퇴할 수 없어요. 학원을 먼저 삭제해 주세요. 학원을 삭제하면 그 학원의 원생·직원·출결·결제 기록이 모두 지워져요.",
  blockedAdmin: "관리자 계정은 탈퇴할 수 없어요.",
  toAcademyList: "학원 목록으로",
  doneTitle: "탈퇴했어요",
  doneBody: "그동안 attn.을 이용해 주셔서 감사해요.",
  doneHome: "첫 화면으로",
  loadError: "정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.",
} as const;

export const ACADEMY_DELETE_TEXT = {
  title: "학원 삭제",
  warning: (name: string) =>
    `「${name}」의 원생·보호자·직원·반·출결·수납·결제 기록이 바로 지워지고 되돌릴 수 없어요.`,
  accounts: "이 학원의 학부모·직원 계정도 지워져요(다른 학원에서도 쓰는 계정은 그 학원 이용은 그대로예요).",
  payments: "결제 기록은 학원이 법령에 따라 보관해야 할 수 있어요. 지우기 전에 내려받아 보관해 주세요.",
  paymentsButton: "결제 내역 내려받기(CSV)",
  paymentsBusy: "내려받는 중…",
  paymentsNone: "내려받을 결제 기록이 없어요.",
  paymentsDone: (n: number) => `결제 기록 ${n}건을 내려받았어요.`,
  paymentsError: "결제 내역을 불러오지 못했어요. 다시 시도해 주세요.",
  nameLabel: "확인을 위해 학원 이름을 입력해 주세요",
  nameMismatch: "학원 이름이 맞지 않아요. 다시 입력해 주세요.",
  next: "다음",
  reauthLead: "학원을 삭제하려면 본인 확인이 필요해요.",
  submit: "학원 삭제",
  busy: "삭제하는 중이에요… 창을 닫지 말아 주세요.",
  done: (name: string) => `「${name}」을 삭제했어요.`,
  alreadyDeleted: "이미 삭제된 학원이에요.",
  failed: "삭제를 끝내지 못했어요. [다시 시도]를 누르면 이어서 지워요.",
  retry: "다시 시도",
  cancel: "취소",
} as const;

/** 원장 벨 — 본인 탈퇴(`member_withdrawn`, 전화번호 없음) */
export function memberWithdrawnBellText(
  name: string,
  entityType: "parent" | "teacher",
  variant: unknown,
): { title: string; detail: string } {
  if (entityType === "parent") {
    return {
      title: `${name} 학부모가 회원 탈퇴했습니다`,
      detail: "본인이 탈퇴했습니다. 자녀 연결은 해제됐고, 원생 정보와 학원이 적은 보호자 번호는 그대로 있습니다.",
    };
  }
  return {
    title: `${name} 직원이 회원 탈퇴했습니다`,
    detail:
      variant === "removed"
        ? "본인이 탈퇴했습니다. 가입 대기 중이던 계정이라 기록 없이 지워졌습니다."
        : "본인이 탈퇴했습니다. 인사 기록은 직원 관리에 「계정 없음」으로 남아 있습니다.",
  };
}

/** Functions 오류의 사유 코드(`details.reason`) */
export function serverReason(e: unknown): string | null {
  const d = (e as { details?: unknown } | null)?.details;
  const r = d && typeof d === "object" ? (d as { reason?: unknown }).reason : undefined;
  return typeof r === "string" ? r : null;
}
