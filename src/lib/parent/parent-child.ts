import { scheduleSummary } from "@/lib/academy/class-schedule";
import type { AcademyClassScheduleSlot, TuitionInvoiceSummary } from "@/lib/firebase/attn-schema";

/**
 * 학부모 앱(`/parent`) 자녀 값 — `listParentChildrenStudents` 응답에서만 만든다(학원 화면의 원생 타입과 분리).
 * 결제·출석 PIN 카드가 쓰는 값 + 다니는 반(이름·수업 시간만, 종강 제외 — 서버가 거름).
 */

export type ParentChildClass = { name: string; schedule: AcademyClassScheduleSlot[] };

export type ParentChildVM = {
  id: string;
  name: string;
  /** 표시 학년(초3 등) */
  gradeLabel: string;
  classes: ParentChildClass[];
  hasCheckInPin: boolean;
  /** 청구 대상(재원) — 휴원 자녀는 결제 카드를 숨김 */
  billable: boolean;
  tuitionDueDayOfMonth: number | null;
  tuitionAmount: number | null;
  tuitionInvoice: TuitionInvoiceSummary | null;
  weeklySessionCount: number | null;
  pricePerSession: number | null;
  sessionBalance: number | null;
  extraSessionDates: string[];
  hasPendingPaymentReminder: boolean;
};

/** 서버 응답 한 명 */
export type ParentChildPayload = {
  id: string;
  name?: string;
  gradeLabel?: string;
  status?: string;
  billable?: boolean;
  hasCheckInPin?: boolean;
  tuitionDueDayOfMonth?: number | null;
  tuitionAmount?: number | null;
  weeklySessionCount?: number | null;
  pricePerSession?: number | null;
  sessionBalance?: number | null;
  extraSessionDates?: string[];
  hasPendingPaymentReminder?: boolean;
  tuitionInvoice?: TuitionInvoiceSummary | null;
  classes?: unknown;
};

function readClasses(raw: unknown): ParentChildClass[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): ParentChildClass[] => {
    const c = x as { name?: unknown; schedule?: unknown } | null;
    if (!c || typeof c.name !== "string" || !c.name) return [];
    const schedule = Array.isArray(c.schedule)
      ? c.schedule.flatMap((s): AcademyClassScheduleSlot[] => {
          const v = s as Record<string, unknown> | null;
          return v && typeof v.weekday === "number" && typeof v.start === "string" && typeof v.end === "string"
            ? [{ weekday: v.weekday, start: v.start, end: v.end }]
            : [];
        })
      : [];
    return [{ name: c.name, schedule }];
  });
}

/**
 * 응답 → 화면 값. `withPaymentReminder`가 거짓이면 납부 안내 자동 창 표시값을 넣지 않는다
 * (목록 새로고침 경로 — 납부 안내 창이 다시 뜨지 않게 하던 기존 동작 그대로).
 */
export function parentChildFromPayload(
  s: ParentChildPayload,
  opts: { withPaymentReminder: boolean },
): ParentChildVM {
  return {
    id: s.id,
    name: s.name ?? "",
    gradeLabel: s.gradeLabel ?? "",
    classes: readClasses(s.classes),
    hasCheckInPin: s.hasCheckInPin === true,
    billable: s.billable !== false,
    tuitionDueDayOfMonth: s.tuitionDueDayOfMonth ?? null,
    tuitionAmount: typeof s.tuitionAmount === "number" ? s.tuitionAmount : null,
    tuitionInvoice: s.tuitionInvoice ?? null,
    weeklySessionCount: typeof s.weeklySessionCount === "number" ? s.weeklySessionCount : null,
    pricePerSession: typeof s.pricePerSession === "number" ? s.pricePerSession : null,
    sessionBalance: typeof s.sessionBalance === "number" ? s.sessionBalance : null,
    extraSessionDates: Array.isArray(s.extraSessionDates) ? s.extraSessionDates : [],
    hasPendingPaymentReminder: opts.withPaymentReminder && s.hasPendingPaymentReminder === true,
  };
}

export function compareParentChildren(a: ParentChildVM, b: ParentChildVM): number {
  return a.name.localeCompare(b.name, "ko");
}

/** "A반 · 월·수 16:00–17:00" — 시간이 없으면 반 이름만 */
export function parentChildClassLine(c: ParentChildClass): string {
  const time = scheduleSummary(c.schedule);
  return time ? `${c.name} · ${time}` : c.name;
}
