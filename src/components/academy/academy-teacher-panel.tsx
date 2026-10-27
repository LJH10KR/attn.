"use client";

import { FirebaseError } from "firebase/app";
import { collection, getDocs, query } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TeacherAssignedStudentsBlock } from "@/components/academy/academy-teacher-assigned-students";
import type { TeacherRegistrationStatus } from "@/lib/firebase/attn-schema";
import { compareAttnIdAsc } from "@/lib/attn-id-sort";
import { getFirebaseDb, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { AcademyPanelRefreshButton } from "@/components/academy/academy-panel-refresh-button";
import { useAcademyListPoll } from "@/lib/firebase/use-academy-list-poll";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";
import { AcademyMemberCredentialActions } from "@/components/academy/academy-member-provision";

const glassCard = "glass-card";

const inputClass =
  "min-w-0 flex-1 rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-2.5 text-sm text-foreground shadow-inner outline-none placeholder:text-neutral-400 focus:border-[#4a90e2]/50 focus:bg-white/70";

export type TeacherRowVM = {
  id: string;
  attnId: string;
  loginId: string;
  name: string;
  email: string;
  status: TeacherRegistrationStatus;
  subject?: string | null;
  phone?: string | null;
  authUid?: string | null;
};

function callableErr(err: unknown): string {
  if (err instanceof FirebaseError) {
    return err.message || "요청에 실패했습니다.";
  }
  return "요청에 실패했습니다.";
}

function StatusDot({ status }: { status: TeacherRegistrationStatus }) {
  if (status === "active") {
    return <span className="h-3 w-3 shrink-0 rounded-full bg-emerald-500 ring-2 ring-emerald-600/30" />;
  }
  if (status === "pending_registration" || status === "pending_setup") {
    return <span className="h-3 w-3 shrink-0 rounded-full bg-amber-400 ring-2 ring-amber-500/40" />;
  }
  return <span className="h-3 w-3 shrink-0 rounded-full bg-red-500 ring-2 ring-red-600/25" />;
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="2" />
      <path d="M15 15l6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const actionBtnClass =
  "rounded-[8px] border border-neutral-300/70 bg-white/55 px-3 py-2 text-[11px] font-medium text-foreground shadow-sm hover:bg-white/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45";

function DeleteTeacherConfirmModal({
  row,
  busy,
  onCancel,
  onConfirm,
}: {
  row: TeacherRowVM;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useBodyScrollLock(true);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  /** 테이블/카드에 transform·overflow가 있으면 fixed가 행 기준으로 잡히므로 body로 포털 */
  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-teacher-dialog-title"
        className={`${glassCard} w-full max-w-md p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="delete-teacher-dialog-title" className="text-base font-semibold text-foreground">
          선생님을 삭제할까요?
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-700">
          <span className="font-medium text-foreground">{row.name || "(이름 없음)"}</span>
          {row.email ? (
            <>
              {" "}
              <span className="text-neutral-500">({row.email})</span>
            </>
          ) : null}
          의 정보를 삭제합니다. 연결된 인증 계정이 있으면 함께 제거될 수 있습니다. 이 작업은 되돌릴 수
          없습니다.
        </p>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            className="rounded-2xl border border-neutral-300/80 bg-white/80 px-4 py-2.5 text-sm font-medium text-neutral-800 hover:bg-white disabled:opacity-50"
            onClick={onCancel}
          >
            취소
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded-2xl bg-red-700 px-4 py-2.5 text-sm font-medium text-white dark:text-neutral-950 hover:bg-red-800 disabled:opacity-50"
            onClick={onConfirm}
          >
            {busy ? "삭제 중…" : "삭제"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type RowActionsProps = {
  academyId: string;
  row: TeacherRowVM;
  busyKey: string | null;
  setBusyKey: (k: string | null) => void;
  setNotice: (m: string | null) => void;
  onListRefresh: () => void;
};

function TeacherRowActions({
  academyId,
  row,
  busyKey,
  setBusyKey,
  setNotice,
  onListRefresh,
}: RowActionsProps) {
  const fn = getFirebaseFunctions();
  const k = (action: string) => `${row.id}:${action}`;
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const run = async (action: string, name: string, exec: () => Promise<unknown>) => {
    setNotice(null);
    setBusyKey(k(action));
    try {
      await exec();
      setNotice(`${name} 처리되었습니다.`);
      onListRefresh();
    } catch (e) {
      setNotice(callableErr(e));
    } finally {
      setBusyKey(null);
    }
  };

  const confirmDeleteTeacher = () => {
    setNotice(null);
    setBusyKey(k("del"));
    void (async () => {
      try {
        const del = httpsCallable(fn, "deleteTeacherInvite");
        await del({ academyId, teacherId: row.id });
        setNotice("삭제 처리되었습니다.");
        setDeleteConfirmOpen(false);
        onListRefresh();
      } catch (e) {
        setNotice(callableErr(e));
      } finally {
        setBusyKey(null);
      }
    })();
  };

  let panel: ReactNode;
  switch (row.status) {
    case "active":
      panel = (
        <div className="flex flex-wrap gap-2" role="group" aria-label="선생님 작업">
          <button type="button" disabled className={actionBtnClass}>
            수정
          </button>
          <button
            type="button"
            disabled={busyKey !== null}
            className={actionBtnClass}
            onClick={() => setDeleteConfirmOpen(true)}
          >
            {busyKey === k("del") ? "…" : "삭제"}
          </button>
          <button
            type="button"
            disabled={busyKey !== null}
            className={actionBtnClass}
            onClick={() =>
              void run("deact", "비활성", async () => {
                const h = httpsCallable(fn, "deactivateTeacher");
                await h({ academyId, teacherAuthUid: row.id });
              })
            }
          >
            {busyKey === k("deact") ? "…" : "비활성"}
          </button>
        </div>
      );
      break;
    case "pending_registration":
      panel = (
        <div className="flex flex-wrap gap-2" role="group" aria-label="선생님 작업">
          <button
            type="button"
            disabled={busyKey !== null}
            className={actionBtnClass}
            onClick={() =>
              void run("act", "가입 승인", async () => {
                const h = httpsCallable(fn, "activateTeacher");
                await h({ academyId, teacherAuthUid: row.id });
              })
            }
          >
            {busyKey === k("act") ? "…" : "가입 승인"}
          </button>
          <button
            type="button"
            disabled={busyKey !== null}
            className={actionBtnClass}
            onClick={() => setDeleteConfirmOpen(true)}
          >
            {busyKey === k("del") ? "…" : "가입 거절"}
          </button>
        </div>
      );
      break;
    case "inactive":
      panel = (
        <div className="flex flex-wrap gap-2" role="group" aria-label="선생님 작업">
          <button type="button" disabled className={actionBtnClass}>
            수정
          </button>
          <button
            type="button"
            disabled={busyKey !== null}
            className={actionBtnClass}
            onClick={() => setDeleteConfirmOpen(true)}
          >
            {busyKey === k("del") ? "…" : "삭제"}
          </button>
          <button
            type="button"
            disabled={busyKey !== null}
            className={actionBtnClass}
            onClick={() =>
              void run("act", "활성", async () => {
                const h = httpsCallable(fn, "activateTeacher");
                await h({ academyId, teacherAuthUid: row.id });
              })
            }
          >
            {busyKey === k("act") ? "…" : "활성"}
          </button>
        </div>
      );
      break;
    default:
      panel = null;
  }

  return (
    <>
      {panel}
      {deleteConfirmOpen ? (
        <DeleteTeacherConfirmModal
          row={row}
          busy={busyKey === k("del")}
          onCancel={() => {
            if (busyKey !== k("del")) setDeleteConfirmOpen(false);
          }}
          onConfirm={confirmDeleteTeacher}
        />
      ) : null}
    </>
  );
}

function docToRow(id: string, data: Record<string, unknown>): TeacherRowVM {
  const status = (data.status as TeacherRegistrationStatus) || "pending_setup";
  return {
    id,
    attnId: typeof data.attnId === "string" ? data.attnId : "",
    loginId: typeof data.loginId === "string" ? data.loginId : "",
    name: typeof data.displayName === "string" ? data.displayName : "",
    email: typeof data.email === "string" ? data.email : "",
    status,
    subject: (data.subject as string | null) ?? null,
    phone: (data.phone as string | null) ?? null,
    authUid: typeof data.authUid === "string" ? data.authUid : null,
  };
}

export function AcademyTeacherPanel({ academyId }: { academyId: string }) {
  const [queryText, setQueryText] = useState("");
  const [expandedTeacherId, setExpandedTeacherId] = useState<string | null>(null);
  const [rows, setRows] = useState<TeacherRowVM[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const loadTeachersList = useCallback(async () => {
    try {
      const db = getFirebaseDb();
      const qy = query(collection(db, "academies", academyId, "staff"));
      const snap = await getDocs(qy);
      setListError(null);
      // 계정 없이 인사 정보만 있는 직원은 직원 관리에서만 보임
      const list = snap.docs
        .filter((d) => d.get("status") !== "no_account")
        .map((d) => docToRow(d.id, d.data() as Record<string, unknown>));
      list.sort((a, b) => compareAttnIdAsc(a.attnId, b.attnId));
      setRows(list);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "목록을 불러오지 못했습니다.");
      setRows([]);
    }
  }, [academyId]);

  const { refresh: refreshTeachersList, busy: listBusy } = useAcademyListPoll(
    loadTeachersList,
    [academyId],
  );

  const filtered = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    if (!q) {
      return rows;
    }
    return rows.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.email.toLowerCase().includes(q),
    );
  }, [rows, queryText]);

  useEffect(() => {
    if (
      expandedTeacherId &&
      !filtered.some((row) => row.id === expandedTeacherId)
    ) {
      setExpandedTeacherId(null);
    }
  }, [filtered, expandedTeacherId]);

  return (
    <div className="space-y-4">
      {notice ? (
        <p className="rounded-2xl bg-emerald-500/10 px-3 py-2 text-center text-xs text-emerald-900 ring-1 ring-emerald-500/20">
          {notice}
        </p>
      ) : null}
      {listError ? (
        <p className="rounded-2xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
          {listError}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">선생님 관리</h2>
        <div className="flex shrink-0 items-center gap-2">
          <AcademyPanelRefreshButton busy={listBusy} onRefreshAction={refreshTeachersList} />
          <Link
            href={`/academy/settings/staff?id=${encodeURIComponent(academyId)}`}
            className="rounded-[8px] bg-[#222] dark:bg-neutral-100 px-3 py-2 text-[11px] font-medium text-white dark:text-neutral-950 shadow-sm hover:bg-[#333] dark:hover:bg-white"
          >
            + 직원 관리에서 초대
          </Link>
        </div>
      </div>

      <div className="flex gap-2">
        <input
          type="search"
          className={inputClass}
          placeholder="이름 또는 이메일로 검색"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          aria-label="선생님 검색"
        />
        <button
          type="button"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#222] dark:bg-neutral-100 text-white shadow-sm hover:bg-[#333] dark:hover:bg-white"
          aria-label="검색"
        >
          <SearchIcon />
        </button>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-[10px] text-neutral-600">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-emerald-500" /> 활성
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-amber-400" /> 승인 대기·첫 로그인 전
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-red-500" /> 비활성
        </span>
      </div>

      <div className="relative space-y-2 pb-16">
        {filtered.length === 0 ? (
          <p className={`py-10 text-center text-sm text-neutral-500 ${glassCard}`}>
            {rows.length === 0 ? "등록된 선생님이 없습니다." : "검색 결과가 없습니다."}
          </p>
        ) : (
          filtered.map((t) => {
            const expanded = expandedTeacherId === t.id;
            return (
              <div
                key={t.id}
                className={`overflow-hidden ${glassCard} ${expanded ? "ring-1 ring-[#222]/10" : ""}`}
              >
                <div className="flex items-stretch gap-1 p-2 sm:gap-2 sm:p-3.5">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-2 py-2 text-left transition hover:bg-white/35 active:bg-white/45 sm:px-3"
                    aria-expanded={expanded}
                    aria-controls={`teacher-actions-${t.id}`}
                    id={`teacher-row-${t.id}`}
                    onClick={() =>
                      setExpandedTeacherId((prev) => (prev === t.id ? null : t.id))
                    }
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-foreground">{t.name}</span>
                      <span className="mt-0.5 block truncate text-xs text-neutral-500">
                        {t.email}
                      </span>
                    </span>
                    <StatusDot status={t.status} />
                  </button>
                </div>
                {expanded ? (
                  <div
                    id={`teacher-actions-${t.id}`}
                    role="region"
                    aria-labelledby={`teacher-row-${t.id}`}
                    className="border-t border-white/60 bg-white/20 px-3 py-3 sm:px-4"
                  >
                    <TeacherAssignedStudentsBlock
                      academyId={academyId}
                      teacherId={t.id}
                      teacherName={t.name || t.email || t.id}
                      teacherStatus={t.status}
                      setNoticeAction={setNotice}
                    />
                    <AcademyMemberCredentialActions
                      academyId={academyId}
                      authUid={t.id}
                      role="teacher"
                      attnId={t.attnId}
                      loginId={t.loginId || undefined}
                      status={t.status}
                    />
                    <TeacherRowActions
                      academyId={academyId}
                      row={t}
                      busyKey={busyKey}
                      setBusyKey={setBusyKey}
                      setNotice={setNotice}
                      onListRefresh={refreshTeachersList}
                    />
                  </div>
                ) : null}
              </div>
            );
          })
        )}

      </div>

    </div>
  );
}
