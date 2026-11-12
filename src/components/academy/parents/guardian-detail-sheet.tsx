"use client";

import { httpsCallable } from "firebase/functions";
import { useEffect, useMemo, useState } from "react";
import {
  AppStateBadge,
  callableCode,
  callableMessage,
  ConfirmDialog,
  dangerSmallBtnClass,
  fmtDate,
  PushBadge,
  sectionClass,
  smallBtnClass,
  won,
} from "@/components/academy/parents/parent-ui";
import { STUDENT_STATUS_BADGE_CLASS } from "@/components/academy/student-detail/student-detail-sheet";
import { TempCredentialsDialog, type TempCredentialRow } from "@/components/academy/temp-credentials-dialog";
import { ModalPortal } from "@/components/ui/modal-portal";
import { seoulDateString } from "@/lib/academy/attendance-records";
import {
  canCreateForGroup,
  groupAppState,
  isAwaitingApproval,
  parentAccountActions,
  parentAppState,
  parentPushState,
  type GuardianGroup,
  type ParentAccountVM,
} from "@/lib/academy/parent-directory";
import { loadStudentInvoices } from "@/lib/academy/student-detail/billing-source";
import { invoiceAmount, invoiceDueState } from "@/lib/academy/student-detail/invoice-due-state";
import { STUDENT_STATUS_LABELS } from "@/lib/academy/student-profile";
import { guardianRelationLabel } from "@/lib/academy/student-row";
import type { AcademyOptionItem } from "@/lib/firebase/attn-schema";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { formatKrPhoneDisplayOrDash } from "@/lib/phone/kr-phone";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

/** 합산 미납에 쓰는 청구서 범위 — 자녀마다 최근 24개월 */
const INVOICE_MONTHS = 24;

type DueSum = { count: number; sum: number; unknown: number };
type BillingSummary =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ok"; overdue: DueSum; upcoming: DueSum; byChild: { id: string; name: string; overdue: DueSum }[] };

type PendingAction =
  | { kind: "deactivate" | "activate" | "reset" | "regenerate" | "delete"; account: ParentAccountVM }
  | { kind: "unlink"; account: ParentAccountVM; studentId: string; studentName: string };

const emptySum = (): DueSum => ({ count: 0, sum: 0, unknown: 0 });

function linkLabel(a: ParentAccountVM): string {
  if (isAwaitingApproval(a)) return "승인·연결";
  if (parentAppState(a) === "unlinked") return "다시 연결";
  return "원생 더 연결";
}

/**
 * 보호자 상세 시트(9-5) — 주소 없이 state로 연다. 자녀를 누르면 학생 상세 시트(주소 `?student=`)가 위에 열린다.
 * 자녀 합산 미납은 청구서 읽기 권한(`billing.invoices`·`billing.collections`)이 있을 때만 읽고 보여 준다(규칙과 같음).
 * 계정 관리 버튼은 서버가 허용하는 상태에서만 보인다(`parentAccountActions`).
 */
export function GuardianDetailSheet({
  academyId,
  group,
  relations,
  canBilling,
  nowMs,
  notice,
  escapeBlocked = false,
  onOpenStudentAction,
  onLinkAction,
  onCreateAction,
  onReloadAction,
  onNoticeAction,
  onCloseAction,
}: {
  academyId: string;
  group: GuardianGroup;
  relations: readonly AcademyOptionItem[];
  canBilling: boolean;
  nowMs: number;
  /**
   * 결과 안내(비활성화·연결 해제·연결 결과 등) — 목록 화면의 안내는 이 전체 화면 시트 아래에 가려지므로
   * 시트 안에도 같은 문구를 보여 준다
   */
  notice?: string | null;
  /** 학생 상세·연결·만들기 시트가 위에 열려 있으면 Esc 무시 */
  escapeBlocked?: boolean;
  onOpenStudentAction: (studentId: string) => void;
  onLinkAction: (account: ParentAccountVM) => void;
  onCreateAction: () => void;
  onReloadAction: () => void;
  onNoticeAction: (message: string) => void;
  onCloseAction: () => void;
}) {
  useBodyScrollLock(true);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<{ title: string; row: TempCredentialRow } | null>(null);
  const [billing, setBilling] = useState<BillingSummary>({ state: "loading" });
  const [billingKey, setBillingKey] = useState(0);

  const childKey = group.children.map((c) => c.student.id).join(",");
  const childList = useMemo(
    () => group.children.map((c) => ({ id: c.student.id, name: c.student.name, tuitionAmount: c.student.tuitionAmount })),
    // 자녀 구성이 바뀔 때만 다시 읽는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [childKey],
  );

  useEffect(() => {
    if (!canBilling) return;
    let cancelled = false;
    setBilling({ state: "loading" });
    const today = seoulDateString();
    Promise.all(childList.map((c) => loadStudentInvoices(academyId, c.id, INVOICE_MONTHS))).then(
      (lists) => {
        if (cancelled) return;
        const overdue = emptySum();
        const upcoming = emptySum();
        const byChild = childList.map((c, i) => {
          const childOverdue = emptySum();
          for (const row of lists[i] ?? []) {
            const due = invoiceDueState(row, today);
            if (due === "paid") continue;
            const amount = invoiceAmount(row, c.tuitionAmount);
            const targets = due === "overdue" ? [overdue, childOverdue] : [upcoming];
            for (const t of targets) {
              t.count += 1;
              if (amount == null) t.unknown += 1;
              else t.sum += amount;
            }
          }
          return { id: c.id, name: c.name, overdue: childOverdue };
        });
        setBilling({ state: "ok", overdue, upcoming, byChild });
      },
      () => {
        if (!cancelled) setBilling({ state: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [academyId, canBilling, childList, billingKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || escapeBlocked || busy || credentials) return;
      if (pending) setPending(null);
      else onCloseAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [escapeBlocked, busy, credentials, pending, onCloseAction]);

  const accountByUid = useMemo(() => new Map(group.accounts.map((a) => [a.uid, a])), [group.accounts]);

  const runAction = async () => {
    if (!pending) return;
    const fns = getFirebaseFunctions();
    const a = pending.account;
    const who = a.displayName || "학부모";
    setBusy(true);
    setActionError(null);
    try {
      switch (pending.kind) {
        case "deactivate":
          await httpsCallable(fns, "deactivateParent")({ academyId, parentAuthUid: a.uid });
          onNoticeAction(`${who} 계정을 비활성화했습니다.`);
          break;
        case "activate":
          await httpsCallable(fns, "activateParent")({ academyId, parentAuthUid: a.uid });
          onNoticeAction(`${who} 계정을 다시 활성화했습니다.`);
          break;
        case "reset": {
          const res = await httpsCallable(fns, "resetMemberPassword")({
            academyId,
            memberAuthUid: a.uid,
            role: "parent",
          });
          const d = res.data as { loginId?: string; displayName?: string; tempPassword: string };
          setCredentials({
            title: "비밀번호를 초기화했습니다",
            row: { displayName: d.displayName || who, loginId: d.loginId || a.loginId, tempPassword: d.tempPassword },
          });
          break;
        }
        case "regenerate": {
          const res = await httpsCallable(fns, "regenerateMemberTempPassword")({
            academyId,
            memberAuthUid: a.uid,
            role: "parent",
          });
          const d = res.data as { displayName?: string; tempPassword: string };
          setCredentials({
            title: "임시 비밀번호를 다시 발급했습니다",
            row: { displayName: d.displayName || who, loginId: a.loginId, tempPassword: d.tempPassword },
          });
          break;
        }
        case "delete":
          await httpsCallable(fns, "deleteParentAccount")({ academyId, parentUid: a.uid });
          onNoticeAction(
            parentAccountActions(a).deleteLabel === "가입 거절"
              ? `${who}님의 가입을 거절했습니다.`
              : `${who} 계정을 삭제했습니다.`,
          );
          break;
        case "unlink":
          await httpsCallable(fns, "unlinkParentFromStudent")({
            academyId,
            parentUid: a.uid,
            studentId: pending.studentId,
          });
          onNoticeAction(`${pending.studentName}에서 ${who} 계정 연결을 해제했습니다.`);
          break;
      }
      setPending(null);
      onReloadAction();
    } catch (e) {
      if (callableCode(e) === "not-found") {
        setPending(null);
        onNoticeAction("다른 곳에서 이 계정이나 원생이 삭제되었습니다.");
        onReloadAction();
      } else {
        setActionError(callableMessage(e, "요청을 처리하지 못했습니다."));
        if (callableCode(e) === "failed-precondition") onReloadAction();
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmText = (p: PendingAction): { title: string; body: string; label: string; danger: boolean } => {
    const who = p.account.displayName || "이 학부모";
    switch (p.kind) {
      case "deactivate":
        return {
          title: `${who} 계정을 비활성화할까요?`,
          body: "로그인할 수 없고 알림도 받지 않습니다. 자녀 연결은 그대로 남고, 다시 활성화할 수 있습니다.",
          label: "비활성화",
          danger: true,
        };
      case "activate":
        return {
          title: `${who} 계정을 다시 활성화할까요?`,
          body: "다시 로그인할 수 있습니다. 연결된 자녀가 없으면 연결 대기 상태가 됩니다.",
          label: "재활성화",
          danger: false,
        };
      case "reset":
        return {
          title: `${who} 계정 비밀번호를 초기화할까요?`,
          body: "새 임시 비밀번호를 발급하고 지금 로그인된 기기에서 로그아웃됩니다. 학부모는 임시 비밀번호로 로그인해 새 비밀번호를 정합니다.",
          label: "초기화",
          danger: true,
        };
      case "regenerate":
        return {
          title: "임시 비밀번호를 다시 발급할까요?",
          body: "이전 임시 비밀번호는 더 이상 쓸 수 없습니다.",
          label: "다시 발급",
          danger: false,
        };
      case "delete": {
        const reject = parentAccountActions(p.account).deleteLabel === "가입 거절";
        return {
          title: reject ? `${who}님의 가입을 거절할까요?` : `${who} 계정을 삭제할까요?`,
          body: "앱 계정과 로그인 정보가 삭제되고 자녀 연결도 모두 풀립니다. 원생 정보와 보호자 연락처는 그대로 남습니다.",
          label: reject ? "가입 거절" : "삭제",
          danger: true,
        };
      }
      case "unlink":
        return {
          title: `${p.studentName}에서 연결을 해제할까요?`,
          body: `${who} 계정에서 이 원생이 보이지 않게 됩니다. 보호자 연락처는 원생 정보에 그대로 남습니다. 이 학부모는 이 원생에 다시 자동 연결되지 않아요(직접 연결은 가능).`,
          label: "연결 해제",
          danger: true,
        };
    }
  };

  const state = groupAppState(group);
  const relationText = group.relationIds.map((id) => guardianRelationLabel(id, relations)).join(", ");
  const canCreate = canCreateForGroup(group);

  const sumText = (s: DueSum) =>
    s.count === 0 ? "없음" : `${s.count}건 · ${won(s.sum)}${s.unknown > 0 ? ` (금액 미정 ${s.unknown}건)` : ""}`;

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[150] flex flex-col bg-background"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guardian-detail-title"
      >
        <header className="shrink-0 border-b border-neutral-200/80 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="mx-auto max-w-lg">
            <button
              type="button"
              onClick={onCloseAction}
              className="-ml-1 rounded-full px-1 py-1 text-sm text-neutral-500 hover:text-foreground"
              aria-label="닫기"
            >
              ← 닫기
            </button>
            <div className="mt-1 flex items-center gap-2">
              <h1 id="guardian-detail-title" className="min-w-0 truncate text-xl font-semibold text-foreground">
                {group.displayName}
              </h1>
              <AppStateBadge state={state} extra={group.accounts.length > 1 ? ` +${group.accounts.length - 1}` : undefined} />
            </div>
            <p className="mt-0.5 text-xs text-neutral-600">
              {formatKrPhoneDisplayOrDash(group.phone)}
              {relationText ? ` · ${relationText}` : ""}
              {group.appName ? ` · 앱: ${group.appName}` : ""}
            </p>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-lg space-y-3 px-4 py-4 pb-10">
            {notice ? (
              <p
                className="break-keep rounded-2xl bg-emerald-500/10 px-3 py-2 text-center text-xs text-emerald-900 ring-1 ring-emerald-500/20"
                role="status"
              >
                {notice}
              </p>
            ) : null}
            <section className={sectionClass}>
              <h2 className="mb-1 text-xs font-semibold text-foreground">자녀 {group.children.length}명</h2>
              {group.children.length === 0 ? (
                <p className="break-keep py-2 text-xs text-neutral-500">
                  이 번호를 보호자로 둔 원생이 없습니다. 계정의 원생 연결 버튼으로 직접 골라 연결할 수 있습니다.
                </p>
              ) : (
                <ul className="-mx-1 divide-y divide-neutral-200/70">
                  {group.children.map((c) => {
                    const s = c.student;
                    return (
                      <li key={s.id} className="py-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenStudentAction(s.id)}
                          className="flex w-full items-center gap-2 rounded-xl px-1 py-1 text-left hover:bg-black/[0.03]"
                        >
                          <span className="min-w-0 truncate text-sm text-foreground">{s.name || "(이름 없음)"}</span>
                          {s.gradeLabel ? <span className="shrink-0 text-[11px] text-neutral-500">{s.gradeLabel}</span> : null}
                          {s.status !== "enrolled" ? (
                            <span
                              className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${STUDENT_STATUS_BADGE_CLASS[s.status]}`}
                            >
                              {STUDENT_STATUS_LABELS[s.status]}
                            </span>
                          ) : null}
                          {c.entry ? (
                            <span className="shrink-0 text-[10px] text-neutral-500">
                              {guardianRelationLabel(c.entry.relationId, relations)}
                            </span>
                          ) : null}
                          <span aria-hidden className="ml-auto shrink-0 text-neutral-400">
                            ›
                          </span>
                        </button>
                        <div className="space-y-1 px-1">
                          {c.linkedUids.map((uid) => {
                            const acc = accountByUid.get(uid);
                            if (!acc) return null;
                            const acts = parentAccountActions(acc);
                            return (
                              <div key={uid} className="flex items-center gap-2 text-[11px]">
                                <span className="min-w-0 truncate text-emerald-800">
                                  앱 연결됨{group.accounts.length > 1 ? ` (${acc.displayName || "이름 없음"})` : ""}
                                </span>
                                {acts.unlink ? (
                                  <button
                                    type="button"
                                    className={`ml-auto ${dangerSmallBtnClass}`}
                                    disabled={busy}
                                    onClick={() => {
                                      setActionError(null);
                                      setPending({ kind: "unlink", account: acc, studentId: s.id, studentName: s.name || "원생" });
                                    }}
                                  >
                                    연결 해제
                                  </button>
                                ) : null}
                              </div>
                            );
                          })}
                          {c.foreignAccount ? (
                            <p className="break-keep text-[11px] text-neutral-500">
                              다른 번호의 계정({c.foreignAccount.displayName || "이름 없음"})에 연결됨
                            </p>
                          ) : null}
                          {c.mismatchPhone ? (
                            <p className="break-keep text-[11px] text-amber-800">
                              보호자 번호가 계정 번호와 다름(원생 쪽: {formatKrPhoneDisplayOrDash(c.mismatchPhone)})
                            </p>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {canBilling && group.children.length > 0 ? (
              <section className={sectionClass}>
                <h2 className="mb-1 text-xs font-semibold text-foreground">자녀 합산 미납</h2>
                {billing.state === "loading" ? (
                  <p className="py-2 text-xs text-neutral-400">불러오는 중…</p>
                ) : billing.state === "error" ? (
                  <p className="py-2 text-xs text-red-800">
                    청구서를 불러오지 못했습니다.{" "}
                    <button type="button" className="underline" onClick={() => setBillingKey((k) => k + 1)}>
                      다시 시도
                    </button>
                  </p>
                ) : (
                  <>
                    <dl className="space-y-1 text-xs">
                      <div className="flex justify-between gap-3">
                        <dt className="text-neutral-500">미납(납부일 지남)</dt>
                        <dd className={billing.overdue.count > 0 ? "font-semibold text-red-800" : "text-foreground"}>
                          {sumText(billing.overdue)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-neutral-500">납부 예정</dt>
                        <dd className="text-foreground">{sumText(billing.upcoming)}</dd>
                      </div>
                    </dl>
                    {billing.overdue.count > 0 && billing.byChild.length > 1 ? (
                      <ul className="mt-2 space-y-0.5 border-t border-neutral-200/70 pt-2 text-[11px] text-neutral-600">
                        {billing.byChild
                          .filter((c) => c.overdue.count > 0)
                          .map((c) => (
                            <li key={c.id} className="flex justify-between gap-3">
                              <span className="truncate">{c.name || "(이름 없음)"}</span>
                              <span>{sumText(c.overdue)}</span>
                            </li>
                          ))}
                      </ul>
                    ) : null}
                    <p className="mt-1.5 text-[10px] text-neutral-400">자녀별 최근 {INVOICE_MONTHS}개월 청구서 기준</p>
                  </>
                )}
              </section>
            ) : null}

            <section className={sectionClass}>
              <h2 className="mb-1 text-xs font-semibold text-foreground">
                앱 계정{group.accounts.length > 1 ? ` ${group.accounts.length}개` : ""}
              </h2>
              {group.accounts.length > 1 ? (
                <p className="mb-2 break-keep rounded-xl bg-amber-500/12 px-3 py-2 text-[11px] text-amber-950">
                  같은 번호의 계정이 {group.accounts.length}개 있습니다. 한 계정에 자녀를 모두 연결하고 나머지는 삭제(가입
                  거절)해 주세요.
                </p>
              ) : null}
              {group.accounts.length === 0 ? (
                <div className="space-y-2 py-1">
                  <p className="break-keep text-xs text-neutral-600">
                    {group.hasForeignLinks
                      ? "이 번호의 보호자 항목이 다른 번호의 앱 계정에 연결돼 있습니다."
                      : "아직 앱에 가입하지 않았습니다. 가입 안내 링크를 보내거나 계정을 직접 만들어 줄 수 있습니다."}
                  </p>
                  {canCreate ? (
                    <button
                      type="button"
                      onClick={onCreateAction}
                      className="w-full rounded-2xl bg-[#222] py-2.5 text-sm font-medium text-white"
                    >
                      직접 만들어 주기
                    </button>
                  ) : null}
                </div>
              ) : (
                <ul className="divide-y divide-neutral-200/70">
                  {group.accounts.map((a) => {
                    const acts = parentAccountActions(a);
                    const push = parentPushState(a, nowMs);
                    return (
                      <li key={a.uid} className="space-y-2 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 truncate text-sm font-medium text-foreground">
                            {a.displayName || "이름 없음"}
                          </span>
                          <AppStateBadge state={parentAppState(a)} />
                          {push ? <PushBadge state={push} /> : null}
                        </div>
                        <dl className="space-y-0.5 text-[11px] text-neutral-600">
                          <div className="flex justify-between gap-3">
                            <dt>로그인 ID</dt>
                            <dd className="break-all text-right">
                              {a.loginId || "—"}
                              {a.authProvider === "google" ? " (Google)" : ""}
                            </dd>
                          </div>
                          <div className="flex justify-between gap-3">
                            <dt>계정 번호</dt>
                            <dd>{formatKrPhoneDisplayOrDash(a.phone)}</dd>
                          </div>
                          <div className="flex justify-between gap-3">
                            <dt>가입일</dt>
                            <dd>{fmtDate(a.createdAtMs)}</dd>
                          </div>
                        </dl>
                        {acts.linkNeedsPhone ? (
                          <p className="break-keep rounded-xl bg-red-500/10 px-3 py-1.5 text-[11px] text-red-800">
                            계정에 휴대폰 번호가 없어 연결할 수 없습니다.
                          </p>
                        ) : null}
                        <div className="flex flex-wrap gap-1.5">
                          {acts.link ? (
                            <button
                              type="button"
                              className="rounded-[8px] bg-[#222] px-2.5 py-1.5 text-[11px] font-medium text-white disabled:opacity-40"
                              disabled={busy}
                              onClick={() => onLinkAction(a)}
                            >
                              {linkLabel(a)}
                            </button>
                          ) : null}
                          {acts.regenerate ? (
                            <button
                              type="button"
                              className={smallBtnClass}
                              disabled={busy}
                              onClick={() => {
                                setActionError(null);
                                setPending({ kind: "regenerate", account: a });
                              }}
                            >
                              임시 비밀번호 재발급
                            </button>
                          ) : null}
                          {acts.resetPassword ? (
                            <button
                              type="button"
                              className={smallBtnClass}
                              disabled={busy}
                              onClick={() => {
                                setActionError(null);
                                setPending({ kind: "reset", account: a });
                              }}
                            >
                              비밀번호 초기화
                            </button>
                          ) : null}
                          {acts.activate ? (
                            <button
                              type="button"
                              className={smallBtnClass}
                              disabled={busy}
                              onClick={() => {
                                setActionError(null);
                                setPending({ kind: "activate", account: a });
                              }}
                            >
                              재활성화
                            </button>
                          ) : null}
                          {acts.deactivate ? (
                            <button
                              type="button"
                              className={dangerSmallBtnClass}
                              disabled={busy}
                              onClick={() => {
                                setActionError(null);
                                setPending({ kind: "deactivate", account: a });
                              }}
                            >
                              비활성화
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className={dangerSmallBtnClass}
                            disabled={busy}
                            onClick={() => {
                              setActionError(null);
                              setPending({ kind: "delete", account: a });
                            }}
                          >
                            {acts.deleteLabel}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </main>
      </div>

      {pending ? (
        (() => {
          const t = confirmText(pending);
          return (
            <ConfirmDialog
              title={t.title}
              body={t.body}
              confirmLabel={t.label}
              danger={t.danger}
              busy={busy}
              error={actionError}
              onCancelAction={() => setPending(null)}
              onConfirmAction={() => void runAction()}
            />
          );
        })()
      ) : null}
      {credentials ? (
        <TempCredentialsDialog
          title={credentials.title}
          description="로그인 ID와 임시 비밀번호를 학부모에게 전달해 주세요."
          rows={[credentials.row]}
          onConfirmAction={() => {
            setCredentials(null);
            onNoticeAction(`${credentials.row.displayName} 계정의 임시 비밀번호를 발급했습니다.`);
          }}
        />
      ) : null}
    </ModalPortal>
  );
}
