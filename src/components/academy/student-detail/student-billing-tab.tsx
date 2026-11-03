"use client";

import { FirebaseError } from "firebase/app";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { SessionLogModal } from "@/components/academy/session-log-modal";
import { TuitionInvoiceModal } from "@/components/academy/tuition-invoice-modal";
import {
  chargeStudentSessions,
  ChargeSessionModal,
  recordStudentSessionComplete,
  SessionCompleteConfirmModal,
  TuitionSettingModal,
} from "@/components/academy/student-detail/billing-modals";
import {
  loadStudentInvoices,
  loadStudentPayments,
  loadStudentSessionLogs,
  type StudentInvoiceRow,
  type StudentPaymentRow,
  type StudentSessionLogRow,
} from "@/lib/academy/student-detail/billing-source";
import {
  INVOICE_DUE_STATE_BADGE_CLASS,
  INVOICE_DUE_STATE_LABELS,
  invoiceAmount,
  invoiceDueState,
} from "@/lib/academy/student-detail/invoice-due-state";
import { seoulDateString } from "@/lib/academy/attendance-records";
import type { StudentVM } from "@/lib/academy/student-row";
import type { StudentAccess } from "@/lib/academy/use-student-access";
import type { AcademyPaymentStatus } from "@/lib/firebase/attn-schema";
import { formatInvoicePeriod } from "@/lib/payment/tuition-invoice";

const sectionClass = "rounded-2xl border border-neutral-200/80 bg-white/40 px-4 py-3";
const btnClass =
  "rounded-[8px] border border-neutral-300/70 bg-white/70 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-white disabled:opacity-40";

const PAYMENT_STATUS_LABELS: Record<AcademyPaymentStatus, string> = {
  PAID: "결제 완료",
  CANCELLED: "취소",
  FAILED: "실패",
  PENDING: "진행 중",
};

function won(n: number): string {
  return `${n.toLocaleString("ko-KR")}원`;
}

function fmtDate(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "2-digit",
    month: "numeric",
    day: "numeric",
  });
}

function errMsg(e: unknown): string {
  if (e instanceof FirebaseError) return e.message || "요청에 실패했습니다.";
  return e instanceof Error && e.message ? e.message : "요청에 실패했습니다.";
}

type Loaded<T> = { state: "loading" } | { state: "ok"; rows: T[] } | { state: "error"; message: string };

function useLoaded<T>(enabled: boolean, load: () => Promise<T[]>, reloadKey: number): Loaded<T> {
  const [value, setValue] = useState<Loaded<T>>({ state: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setValue({ state: "loading" });
    load().then(
      (rows) => {
        if (!cancelled) setValue({ state: "ok", rows });
      },
      (e: unknown) => {
        if (!cancelled) setValue({ state: "error", message: e instanceof Error ? e.message : "불러오지 못했습니다." });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, load, reloadKey]);
  return value;
}

function LoadedList<T>({
  value,
  empty,
  render,
}: {
  value: Loaded<T>;
  empty: string;
  render: (row: T) => ReactNode;
}) {
  if (value.state === "loading") return <p className="py-2 text-xs text-neutral-400">불러오는 중…</p>;
  if (value.state === "error") return <p className="py-2 text-xs text-red-700">{value.message}</p>;
  if (value.rows.length === 0) return <p className="py-2 text-xs text-neutral-500">{empty}</p>;
  return <ul className="divide-y divide-neutral-200/70">{value.rows.map(render)}</ul>;
}

/**
 * 결제 탭 — 원비·회차 카드(원비 설정·충전·수업 완료·기록), 청구서, 결제 내역.
 * 섹션·버튼 노출은 `studentAccess` 결과만 쓴다(4-4절).
 */
export function StudentBillingTab({
  academyId,
  student,
  access,
  onNoticeAction,
}: {
  academyId: string;
  student: StudentVM;
  access: StudentAccess;
  onNoticeAction: (message: string) => void;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [tuitionOpen, setTuitionOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const isSession = student.weeklySessionCount != null;
  const isMonthly = Boolean(student.tuitionDueDayOfMonth);
  const reload = () => setReloadKey((k) => k + 1);

  const studentId = student.id;
  const loadLogs = useCallback(() => loadStudentSessionLogs(academyId, studentId), [academyId, studentId]);
  const loadInvoices = useCallback(() => loadStudentInvoices(academyId, studentId), [academyId, studentId]);
  const loadPayments = useCallback(() => loadStudentPayments(academyId, studentId), [academyId, studentId]);
  const logs = useLoaded<StudentSessionLogRow>(access.sessionLogs && isSession, loadLogs, reloadKey);
  const invoices = useLoaded<StudentInvoiceRow>(access.invoices, loadInvoices, reloadKey);
  const payments = useLoaded<StudentPaymentRow>(access.payments, loadPayments, reloadKey);

  const onComplete = async () => {
    setBusy(true);
    try {
      await recordStudentSessionComplete(academyId, student.id);
      onNoticeAction(`${student.name} 수업 완료 기록이 저장되었습니다.`);
      setCompleteOpen(false);
      reload();
    } catch (e) {
      onNoticeAction(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const onCharge = async (n: number) => {
    setBusy(true);
    try {
      await chargeStudentSessions(academyId, student, n);
      onNoticeAction(`${student.name}에게 ${n}회 충전했습니다.`);
      setChargeOpen(false);
    } catch (e) {
      onNoticeAction(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <section className={sectionClass}>
        <h3 className="mb-2 text-xs font-semibold text-foreground">원비</h3>
        {isMonthly ? (
          <p className="text-sm text-foreground">
            매월 {student.tuitionDueDayOfMonth}일
            {student.tuitionAmount != null ? ` · ${won(student.tuitionAmount)}` : ""}
          </p>
        ) : isSession ? (
          <p className="text-sm text-foreground">
            회차 방식 · 주 {student.weeklySessionCount}회
            {student.pricePerSession != null ? ` · ${won(student.pricePerSession)}/회` : ""}
          </p>
        ) : (
          <p className="text-sm text-neutral-500">원비가 설정되지 않았습니다.</p>
        )}
        {isSession && student.sessionBalance != null ? (
          <p className={`mt-1 text-xs ${student.sessionBalance < 0 ? "font-medium text-red-700" : "text-neutral-600"}`}>
            잔여 {student.sessionBalance}회{student.sessionBalance < 0 ? " (초과 수업)" : ""}
          </p>
        ) : null}
        {student.tuitionReminderConfirmed ? (
          <p className="mt-1 text-[11px] font-medium text-emerald-700">✓ 학부모 납부 알림 확인 완료</p>
        ) : null}
        {access.tuitionEdit || (isSession && access.sessionComplete) ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {access.tuitionEdit ? (
              <button type="button" className={btnClass} onClick={() => setTuitionOpen(true)}>
                원비 설정
              </button>
            ) : null}
            {isSession && access.sessionComplete ? (
              <button
                type="button"
                className={`${btnClass} border-violet-300/70 bg-violet-50/70 text-violet-800`}
                disabled={busy}
                onClick={() => setCompleteOpen(true)}
              >
                수업 완료
              </button>
            ) : null}
            {isSession && access.tuitionEdit ? (
              <button
                type="button"
                className="rounded-[8px] bg-violet-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                disabled={busy}
                onClick={() => setChargeOpen(true)}
              >
                충전
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      {isSession && access.sessionLogs ? (
        <section className={sectionClass}>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground">수업 완료 기록</h3>
            <button type="button" className={btnClass} onClick={() => setLogsOpen(true)}>
              전체 기록
            </button>
          </div>
          <LoadedList
            value={logs}
            empty="최근 기록이 없습니다."
            render={(l) => (
              <li key={l.id} className="flex justify-between py-1.5 text-xs">
                <span className="text-foreground">{fmtDate(l.recordedAtMs)}</span>
                {l.wasExtra ? <span className="text-red-700">초과 수업</span> : null}
              </li>
            )}
          />
        </section>
      ) : null}

      {access.invoices ? (
        <section className={sectionClass}>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground">청구서</h3>
            {access.manageInvoices && isMonthly && student.tuitionAmount != null ? (
              <button type="button" className={btnClass} onClick={() => setInvoiceOpen(true)}>
                청구서 관리
              </button>
            ) : null}
          </div>
          <LoadedList
            value={invoices}
            empty="청구서 기록이 없습니다."
            render={(r) => {
              const amount = invoiceAmount(r, student.tuitionAmount);
              // 미납부는 납부일이 지났으면 "미납", 당일·전이면 "납부 예정"(보호자 상세 합산과 같은 판단)
              const due = invoiceDueState(r, seoulDateString());
              return (
                <li key={r.period} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                  <span className="text-foreground">{formatInvoicePeriod(r.period)}</span>
                  <span className="flex items-center gap-2">
                    {amount != null ? <span className="text-neutral-700">{won(amount)}</span> : null}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${INVOICE_DUE_STATE_BADGE_CLASS[due]}`}
                    >
                      {due === "paid"
                        ? r.paidMethod === "card"
                          ? "카드 납부"
                          : "납부 완료"
                        : INVOICE_DUE_STATE_LABELS[due]}
                    </span>
                  </span>
                </li>
              );
            }}
          />
        </section>
      ) : null}

      {access.payments ? (
        <section className={sectionClass}>
          <h3 className="mb-1 text-xs font-semibold text-foreground">결제 내역</h3>
          <LoadedList
            value={payments}
            empty="결제 내역이 없습니다."
            render={(p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                <span className="min-w-0 text-foreground">
                  {fmtDate(p.createdAtMs)}
                  <span className="text-neutral-500">
                    {" "}
                    ·{" "}
                    {p.paymentType === "session_based"
                      ? `회차 ${p.sessionCount ?? "?"}회`
                      : p.invoicePeriod
                        ? formatInvoicePeriod(p.invoicePeriod)
                        : "원비"}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-neutral-700">{won(p.amount)}</span>
                  <span className="text-[10px] text-neutral-500">{PAYMENT_STATUS_LABELS[p.status]}</span>
                </span>
              </li>
            )}
          />
        </section>
      ) : null}

      {tuitionOpen ? (
        <TuitionSettingModal
          academyId={academyId}
          student={student}
          onClose={() => setTuitionOpen(false)}
          onSaved={() => onNoticeAction("원비 설정을 저장했습니다.")}
        />
      ) : null}
      {completeOpen ? (
        <SessionCompleteConfirmModal
          student={student}
          busy={busy}
          onCancel={() => {
            if (!busy) setCompleteOpen(false);
          }}
          onConfirm={() => void onComplete()}
        />
      ) : null}
      {chargeOpen ? (
        <ChargeSessionModal
          student={student}
          busy={busy}
          onCancel={() => {
            if (!busy) setChargeOpen(false);
          }}
          onConfirm={(n) => void onCharge(n)}
        />
      ) : null}
      {logsOpen ? (
        <SessionLogModal
          academyId={academyId}
          studentId={student.id}
          studentName={student.name}
          onClose={() => {
            setLogsOpen(false);
            reload();
          }}
          onCancelled={reload}
        />
      ) : null}
      {invoiceOpen && student.tuitionDueDayOfMonth && student.tuitionAmount != null ? (
        <TuitionInvoiceModal
          academyId={academyId}
          studentId={student.id}
          studentName={student.name}
          tuitionAmount={student.tuitionAmount}
          tuitionDueDayOfMonth={student.tuitionDueDayOfMonth}
          studentPerDayDeduction={student.absenceDeductionPerDay}
          onClose={() => {
            setInvoiceOpen(false);
            reload();
          }}
          onNotice={onNoticeAction}
        />
      ) : null}
    </div>
  );
}
