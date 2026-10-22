import * as crypto from "node:crypto";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { assertCanManageAcademy } from "./lib/academy-access";

/**
 * 매월 지정일 납부 청구서 — `academies/{academyId}/students/{studentId}/tuitionInvoices/{YYYY-MM}`.
 * 미납(open) 동안은 조정 항목만 저장하고 금액은 원비 + 조정 합계로 실시간 계산,
 * 납부(paid) 시점에 원비·최종 금액을 고정. 카드 납부 처리는 Next 서버(`src/lib/payment/complete-payment.ts`).
 * 기간 계산 규칙은 `src/lib/payment/tuition-invoice.ts`와 동일하게 유지할 것.
 */

const MAX_ADJUSTMENTS_PER_INVOICE = 20;
const MAX_ADJUSTMENT_ABS_AMOUNT = 10_000_000;
const MAX_ADJUSTMENT_MEMO_LENGTH = 100;
const PERIOD_RE = /^(\d{4})-(\d{2})$/;

export type InvoiceSummary = {
  period: string;
  dueDate: string;
  status: "open" | "paid";
  baseAmount: number;
  adjustments: { amount: number; memo: string }[];
  finalAmount: number;
};

function isValidPeriod(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const m = PERIOD_RE.exec(raw);
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

function shiftPeriod(period: string, delta: number): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export function invoiceDueDate(period: string, dueDayOfMonth: number): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const day = Math.min(dueDayOfMonth, new Date(y, m, 0).getDate());
  return `${period}-${String(day).padStart(2, "0")}`;
}

/** 오늘(서울) 기준 다음 납부일이 속한 달 — 납부일 당일은 이번 달 */
export function nextDueInvoicePeriod(dueDayOfMonth: number, now: Date = new Date()): string {
  const today = now.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const thisPeriod = today.slice(0, 7);
  return today <= invoiceDueDate(thisPeriod, dueDayOfMonth)
    ? thisPeriod
    : shiftPeriod(thisPeriod, 1);
}

function sanitizeAdjustments(raw: unknown): { amount: number; memo: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const { amount, memo } = x as { amount?: unknown; memo?: unknown };
    if (typeof amount !== "number" || !Number.isInteger(amount)) return [];
    return [{ amount, memo: typeof memo === "string" ? memo : "" }];
  });
}

export function computeFinalAmount(
  baseAmount: number,
  adjustments: readonly { amount: number }[],
): number {
  return Math.max(0, baseAmount + adjustments.reduce((acc, a) => acc + a.amount, 0));
}

function readDueDay(studentData: FirebaseFirestore.DocumentData): number | null {
  const d = studentData.tuitionDueDayOfMonth;
  return typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 31 ? d : null;
}

function invoiceRef(
  db: admin.firestore.Firestore,
  academyId: string,
  studentId: string,
  period: string,
) {
  return db.doc(`academies/${academyId}/students/${studentId}/tuitionInvoices/${period}`);
}

/** 청구서 문서(없으면 undefined)로 요약 생성 — 미납이면 현재 원비 기준, 납부면 고정 금액 */
export function buildInvoiceSummary(
  period: string,
  dueDayOfMonth: number,
  tuitionAmount: number,
  invoiceData: FirebaseFirestore.DocumentData | undefined,
): InvoiceSummary {
  const adjustments = sanitizeAdjustments(invoiceData?.adjustments);
  if (invoiceData?.status === "paid") {
    const base = typeof invoiceData.baseAmount === "number" ? invoiceData.baseAmount : tuitionAmount;
    return {
      period,
      dueDate: invoiceDueDate(period, dueDayOfMonth),
      status: "paid",
      baseAmount: base,
      adjustments,
      finalAmount:
        typeof invoiceData.finalAmount === "number"
          ? invoiceData.finalAmount
          : computeFinalAmount(base, adjustments),
    };
  }
  return {
    period,
    dueDate: invoiceDueDate(period, dueDayOfMonth),
    status: "open",
    baseAmount: tuitionAmount,
    adjustments,
    finalAmount: computeFinalAmount(tuitionAmount, adjustments),
  };
}

/**
 * 다음 납부일 청구서 요약 — 학부모 자녀 목록(`listParentChildrenStudents`)·납부 알림 스케줄러에서 사용.
 * 매월 지정일 납부 학생이 아니면(납부일·원비 미설정) null.
 */
export async function loadNextDueInvoiceSummaries(
  db: admin.firestore.Firestore,
  academyId: string,
  students: { id: string; data: FirebaseFirestore.DocumentData }[],
  now: Date = new Date(),
): Promise<Map<string, InvoiceSummary>> {
  const targets = students.flatMap((s) => {
    const dueDay = readDueDay(s.data);
    const tuitionAmount = s.data.tuitionAmount;
    if (!dueDay || typeof tuitionAmount !== "number") return [];
    return [{ id: s.id, dueDay, tuitionAmount, period: nextDueInvoicePeriod(dueDay, now) }];
  });
  const out = new Map<string, InvoiceSummary>();
  if (targets.length === 0) return out;
  const snaps = await db.getAll(...targets.map((t) => invoiceRef(db, academyId, t.id, t.period)));
  targets.forEach((t, i) => {
    out.set(t.id, buildInvoiceSummary(t.period, t.dueDay, t.tuitionAmount, snaps[i]?.data()));
  });
  return out;
}

type InvoiceRequest = {
  db: admin.firestore.Firestore;
  uid: string;
  academyId: string;
  studentId: string;
  period: string;
  dueDay: number;
  ref: FirebaseFirestore.DocumentReference;
};

/**
 * 공통 검증 — 학원 관리 권한, 매월 지정일 납부 학생, 다음 납부 달 기준 전후 1개월 이내 청구서.
 * (지난달: 늦은 납부 확인, 다음 달: 이번 달이 이미 납부된 뒤의 조정)
 */
async function parseInvoiceRequest(
  request: { auth?: { uid: string; token: admin.auth.DecodedIdToken }; data?: unknown },
): Promise<InvoiceRequest> {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const data = (request.data ?? {}) as Record<string, unknown>;
  const academyId = typeof data.academyId === "string" ? data.academyId.trim() : "";
  const studentId = typeof data.studentId === "string" ? data.studentId.trim() : "";
  const period = data.period;
  if (!academyId || !studentId || !isValidPeriod(period)) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  const db = admin.firestore();
  await assertCanManageAcademy(db, academyId, request.auth.uid, request.auth.token);

  const studentSnap = await db.doc(`academies/${academyId}/students/${studentId}`).get();
  if (!studentSnap.exists) {
    throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
  }
  const dueDay = readDueDay(studentSnap.data() ?? {});
  if (!dueDay || typeof studentSnap.get("tuitionAmount") !== "number") {
    throw new HttpsError(
      "failed-precondition",
      "매월 지정일 납부(납부일·원비)가 설정된 학생만 청구서를 관리할 수 있습니다.",
    );
  }
  const next = nextDueInvoicePeriod(dueDay);
  if (period !== next && period !== shiftPeriod(next, -1) && period !== shiftPeriod(next, 1)) {
    throw new HttpsError("invalid-argument", "지난달·이번 납부·다음 달 청구서만 관리할 수 있습니다.");
  }
  return {
    db,
    uid: request.auth.uid,
    academyId,
    studentId,
    period,
    dueDay,
    ref: invoiceRef(db, academyId, studentId, period),
  };
}

/** 원장·학원 포털 — 미납 청구서에 조정 항목 추가(음수 차감·양수 추가, 메모 필수) */
export const addTuitionInvoiceAdjustment = onCall(async (request) => {
  const req = await parseInvoiceRequest(request);
  const amount = request.data?.amount;
  if (
    typeof amount !== "number" ||
    !Number.isInteger(amount) ||
    amount === 0 ||
    Math.abs(amount) > MAX_ADJUSTMENT_ABS_AMOUNT
  ) {
    throw new HttpsError("invalid-argument", "조정 금액이 올바르지 않습니다.");
  }
  const memo =
    typeof request.data?.memo === "string"
      ? request.data.memo.trim().slice(0, MAX_ADJUSTMENT_MEMO_LENGTH)
      : "";
  if (!memo) {
    throw new HttpsError("invalid-argument", "조정 사유를 입력해 주세요. 학부모 납부 화면에 표시됩니다.");
  }

  await req.db.runTransaction(async (tx) => {
    const snap = await tx.get(req.ref);
    const prev = snap.data() ?? {};
    if (prev.status === "paid") {
      throw new HttpsError(
        "failed-precondition",
        "이미 납부된 청구서입니다. 다음 달 청구서에 조정해 주세요.",
      );
    }
    const adjustments = Array.isArray(prev.adjustments) ? prev.adjustments : [];
    if (adjustments.length >= MAX_ADJUSTMENTS_PER_INVOICE) {
      throw new HttpsError(
        "resource-exhausted",
        `조정 항목은 청구서당 최대 ${MAX_ADJUSTMENTS_PER_INVOICE}개입니다.`,
      );
    }
    tx.set(req.ref, {
      period: req.period,
      dueDate: invoiceDueDate(req.period, req.dueDay),
      status: "open",
      adjustments: [
        ...adjustments,
        {
          id: crypto.randomUUID(),
          amount,
          memo,
          source: "manual",
          createdByUid: req.uid,
          // 배열 요소에는 serverTimestamp를 쓸 수 없음
          createdAt: Timestamp.now(),
        },
      ],
      createdAt: prev.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  return { ok: true as const };
});

/** 원장·학원 포털 — 미납 청구서의 조정 항목 삭제 */
export const removeTuitionInvoiceAdjustment = onCall(async (request) => {
  const req = await parseInvoiceRequest(request);
  const adjustmentId =
    typeof request.data?.adjustmentId === "string" ? request.data.adjustmentId : "";
  if (!adjustmentId) {
    throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
  }

  await req.db.runTransaction(async (tx) => {
    const snap = await tx.get(req.ref);
    if (!snap.exists) {
      throw new HttpsError("not-found", "청구서를 찾을 수 없습니다.");
    }
    if (snap.get("status") === "paid") {
      throw new HttpsError("failed-precondition", "이미 납부된 청구서는 수정할 수 없습니다.");
    }
    const adjustments = (snap.get("adjustments") as unknown[] | undefined) ?? [];
    const next = adjustments.filter(
      (a) => !(a && typeof a === "object" && (a as { id?: unknown }).id === adjustmentId),
    );
    if (next.length === adjustments.length) {
      throw new HttpsError("not-found", "조정 항목을 찾을 수 없습니다.");
    }
    tx.update(req.ref, { adjustments: next, updatedAt: FieldValue.serverTimestamp() });
  });
  return { ok: true as const };
});

/**
 * 원장·학원 포털 — 계좌이체·현금 등 카드 외 납부를 확인해 납부 완료로 표시(paid: true),
 * 또는 잘못 표시한 수동 납부를 되돌림(paid: false, 카드 납부는 결제 취소로만 되돌릴 수 있음).
 */
export const setTuitionInvoiceManualPaid = onCall(async (request) => {
  const req = await parseInvoiceRequest(request);
  const paid = request.data?.paid === true;

  await req.db.runTransaction(async (tx) => {
    const [snap, studentSnap] = await tx.getAll(
      req.ref,
      req.db.doc(`academies/${req.academyId}/students/${req.studentId}`),
    );
    const prev = snap!.data() ?? {};

    if (!paid) {
      if (prev.status !== "paid" || prev.paidMethod !== "manual") {
        throw new HttpsError(
          "failed-precondition",
          "직접 납부 완료로 표시한 청구서만 되돌릴 수 있습니다. 카드 결제는 결제 내역에서 취소해 주세요.",
        );
      }
      tx.update(req.ref, {
        status: "open",
        baseAmount: FieldValue.delete(),
        finalAmount: FieldValue.delete(),
        paidAt: FieldValue.delete(),
        paidMethod: FieldValue.delete(),
        paidByUid: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    if (prev.status === "paid") {
      throw new HttpsError("failed-precondition", "이미 납부된 청구서입니다.");
    }
    const baseAmount = studentSnap!.get("tuitionAmount") as number;
    const adjustments = Array.isArray(prev.adjustments) ? prev.adjustments : [];
    tx.set(req.ref, {
      period: req.period,
      dueDate: invoiceDueDate(req.period, req.dueDay),
      status: "paid",
      adjustments,
      baseAmount,
      finalAmount: computeFinalAmount(baseAmount, sanitizeAdjustments(adjustments)),
      paidAt: FieldValue.serverTimestamp(),
      paidMethod: "manual",
      paidByUid: req.uid,
      createdAt: prev.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  return { ok: true as const };
});
