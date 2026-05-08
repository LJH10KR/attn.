"use client";

import { FirebaseError } from "firebase/app";
import {
  addDoc,
  collection,
  getCountFromServer,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  where,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  MAX_STUDENTS_PER_PARENT,
  PARENT_INVITE_TTL_MS,
  type ParentRegistrationStatus,
} from "@/lib/firebase/attn-schema";
import { AcademyParentStudentList } from "@/components/academy/academy-student-panel";
import { getFirebaseDb, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

const glassCard = "glass-card";

const inputClass =
  "min-w-0 flex-1 rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-2.5 text-sm text-foreground shadow-inner outline-none placeholder:text-neutral-400 focus:border-[#4a90e2]/50 focus:bg-white/70";

export type ParentRowVM = {
  id: string;
  name: string;
  email: string;
  status: ParentRegistrationStatus;
  phone?: string | null;
  emergencyContact?: string | null;
  childrenCount: number;
  authUid?: string | null;
  invitationExpiresAt?: Timestamp;
};

function callableErr(err: unknown): string {
  if (err instanceof FirebaseError) {
    return err.message || "요청에 실패했습니다.";
  }
  return "요청에 실패했습니다.";
}

function StatusDot({ status }: { status: ParentRegistrationStatus }) {
  if (status === "active") {
    return <span className="h-3 w-3 shrink-0 rounded-full bg-emerald-500 ring-2 ring-emerald-600/30" />;
  }
  if (status === "invitation_needed") {
    return (
      <span
        className="h-3 w-3 shrink-0 rounded-full border-2 border-neutral-500 bg-transparent"
        aria-hidden
      />
    );
  }
  if (status === "invitation_sent") {
    return (
      <span
        className="h-3 w-3 shrink-0 rounded-full border-2 border-dashed border-sky-500 bg-sky-500/15"
        aria-hidden
      />
    );
  }
  if (status === "pending_registration") {
    return <span className="h-3 w-3 shrink-0 rounded-full bg-amber-400 ring-2 ring-amber-500/40" />;
  }
  return <span className="h-3 w-3 shrink-0 rounded-full bg-red-500 ring-2 ring-red-600/25" />;
}

function readFirestoreTimestamp(v: unknown): Timestamp | undefined {
  if (
    v !== null &&
    v !== undefined &&
    typeof v === "object" &&
    "toMillis" in v &&
    typeof (v as Timestamp).toMillis === "function"
  ) {
    return v as Timestamp;
  }
  return undefined;
}

function formatInviteRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}시간 ${String(m).padStart(2, "0")}분 ${String(s).padStart(2, "0")}초`;
}

function InvitationCountdown({ expiresAt }: { expiresAt: Timestamp }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const ms = expiresAt.toMillis() - now;
  if (ms <= 0) {
    return (
      <span className="text-[11px] font-medium leading-snug text-red-600">
        초청 유효기간(24시간) 만료 · 초청 재발송이 필요합니다
      </span>
    );
  }
  return (
    <span className="text-[11px] leading-snug text-sky-900">
      <span className="text-neutral-500">남은 시간</span>{" "}
      <span className="font-semibold tabular-nums text-sky-800">
        {formatInviteRemaining(ms)}
      </span>
    </span>
  );
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
  "rounded-xl border border-neutral-300/70 bg-white/55 px-3 py-2 text-[11px] font-medium text-foreground shadow-sm hover:bg-white/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45";

function RegisterChildModal({
  parentRow,
  open,
  busy,
  error,
  formName,
  setFormName,
  formAge,
  setFormAge,
  formPhone,
  setFormPhone,
  formEmergency,
  setFormEmergency,
  studentCount,
  countLoading,
  onClose,
  onSubmit,
}: {
  parentRow: ParentRowVM;
  open: boolean;
  busy: boolean;
  error: string | null;
  formName: string;
  setFormName: (v: string) => void;
  formAge: string;
  setFormAge: (v: string) => void;
  formPhone: string;
  setFormPhone: (v: string) => void;
  formEmergency: string;
  setFormEmergency: (v: string) => void;
  studentCount: number | null;
  countLoading: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  useBodyScrollLock(open);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      cancelRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const atCap = studentCount !== null && studentCount >= MAX_STUDENTS_PER_PARENT;
  const remaining =
    studentCount === null ? null : Math.max(0, MAX_STUDENTS_PER_PARENT - studentCount);

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reg-child-title"
        className={`${glassCard} w-full max-w-md max-h-[min(90dvh,640px)] overflow-y-auto p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="reg-child-title" className="text-base font-semibold text-foreground">
          자녀(학생) 등록
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-neutral-600">
          <span className="font-medium text-foreground">{parentRow.name || "(이름 없음)"}</span>
          학부모에게 연결됩니다. 한 학부모당 최대{" "}
          <strong>{MAX_STUDENTS_PER_PARENT}명</strong>까지 등록할 수 있습니다.
        </p>
        {countLoading ? (
          <p className="mt-2 text-[11px] text-neutral-500">등록 인원 확인 중…</p>
        ) : remaining !== null ? (
          <p className="mt-2 text-[11px] text-neutral-600">
            현재 자녀 <span className="font-semibold tabular-nums">{studentCount}</span>명 · 남은
            등록 가능{" "}
            <span className="font-semibold tabular-nums text-sky-900">{remaining}</span>명
          </p>
        ) : null}
        {atCap ? (
          <p className="mt-3 rounded-xl bg-amber-500/15 px-3 py-2 text-xs text-amber-950 ring-1 ring-amber-500/25">
            이미 {MAX_STUDENTS_PER_PARENT}명에 도달했습니다. 더 등록하려면 기존 학생 정리가 필요합니다.
          </p>
        ) : null}
        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="c-name">
              이름 (필수)
            </label>
            <input
              id="c-name"
              className={inputClass}
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              maxLength={80}
              disabled={busy || atCap}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="c-age">
              나이 (필수)
            </label>
            <input
              id="c-age"
              className={inputClass}
              type="number"
              min={0}
              max={120}
              value={formAge}
              onChange={(e) => setFormAge(e.target.value)}
              disabled={busy || atCap}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="c-phone">
              연락처 (필수)
            </label>
            <input
              id="c-phone"
              className={inputClass}
              value={formPhone}
              onChange={(e) => setFormPhone(e.target.value)}
              maxLength={30}
              inputMode="tel"
              disabled={busy || atCap}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="c-em">
              비상 연락처 (필수)
            </label>
            <input
              id="c-em"
              className={inputClass}
              value={formEmergency}
              onChange={(e) => setFormEmergency(e.target.value)}
              maxLength={30}
              inputMode="tel"
              disabled={busy || atCap}
            />
          </div>
        </div>
        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            className="rounded-2xl border border-neutral-300/80 bg-white/80 px-4 py-2.5 text-sm font-medium text-neutral-800 hover:bg-white disabled:opacity-50"
            onClick={onClose}
          >
            취소
          </button>
          <button
            type="button"
            disabled={busy || atCap || countLoading}
            className="rounded-2xl bg-[#222] dark:bg-neutral-100 px-4 py-2.5 text-sm font-medium text-white dark:text-neutral-950 hover:bg-[#333] dark:hover:bg-white disabled:opacity-50"
            onClick={() => onSubmit()}
          >
            {busy ? "등록 중…" : "등록"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DeleteParentConfirmModal({
  row,
  busy,
  onCancel,
  onConfirm,
}: {
  row: ParentRowVM;
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
        aria-labelledby="delete-parent-dialog-title"
        className={`${glassCard} w-full max-w-md p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="delete-parent-dialog-title" className="text-base font-semibold text-foreground">
          학부모를 삭제할까요?
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-700">
          <span className="font-medium text-foreground">{row.name || "(이름 없음)"}</span>
          {row.email ? (
            <>
              {" "}
              <span className="text-neutral-500">({row.email})</span>
            </>
          ) : null}
          님의 정보를 삭제합니다. 연결된 인증 계정이 있으면 함께 제거될 수 있습니다. 이 작업은 되돌릴 수
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
  row: ParentRowVM;
  busyKey: string | null;
  setBusyKey: (k: string | null) => void;
  setNotice: (m: string | null) => void;
};

function ParentRowActions({
  academyId,
  row,
  busyKey,
  setBusyKey,
  setNotice,
}: RowActionsProps) {
  const fn = getFirebaseFunctions();
  const k = (action: string) => `${row.id}:${action}`;
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [childModalOpen, setChildModalOpen] = useState(false);
  const [childStudentCount, setChildStudentCount] = useState<number | null>(null);
  const [childCountLoading, setChildCountLoading] = useState(false);
  const [childFormBusy, setChildFormBusy] = useState(false);
  const [childFormError, setChildFormError] = useState<string | null>(null);
  const [childFormName, setChildFormName] = useState("");
  const [childFormAge, setChildFormAge] = useState("");
  const [childFormPhone, setChildFormPhone] = useState("");
  const [childFormEmergency, setChildFormEmergency] = useState("");

  const refreshChildCount = useCallback(async () => {
    setChildCountLoading(true);
    setChildFormError(null);
    try {
      const db = getFirebaseDb();
      const qy = query(
        collection(db, "academies", academyId, "students"),
        where("parentUserId", "==", row.id),
      );
      const agg = await getCountFromServer(qy);
      setChildStudentCount(agg.data().count);
    } catch {
      setChildFormError("자녀 수를 확인하지 못했습니다.");
      setChildStudentCount(null);
    } finally {
      setChildCountLoading(false);
    }
  }, [academyId, row.id]);

  const openChildModal = useCallback(() => {
    setChildFormName("");
    setChildFormAge("");
    setChildFormPhone("");
    setChildFormEmergency("");
    setChildFormError(null);
    setChildModalOpen(true);
    void refreshChildCount();
  }, [refreshChildCount]);

  const closeChildModal = useCallback(() => {
    if (childFormBusy) {
      return;
    }
    setChildModalOpen(false);
  }, [childFormBusy]);

  const submitChild = useCallback(async () => {
    setChildFormError(null);
    const name = childFormName.trim();
    if (!name || name.length > 80) {
      setChildFormError("이름을 1~80자로 입력해 주세요.");
      return;
    }
    const ageNum = Number.parseInt(childFormAge.trim(), 10);
    if (!Number.isFinite(ageNum) || ageNum < 0 || ageNum > 120) {
      setChildFormError("나이는 0~120 사이 정수로 입력해 주세요.");
      return;
    }
    if (childStudentCount !== null && childStudentCount >= MAX_STUDENTS_PER_PARENT) {
      setChildFormError(`자녀는 학부모당 최대 ${MAX_STUDENTS_PER_PARENT}명까지 등록할 수 있습니다.`);
      return;
    }
    const phone = childFormPhone.trim().slice(0, 30);
    const emergency = childFormEmergency.trim().slice(0, 30);
    if (!phone) {
      setChildFormError("연락처를 입력해 주세요.");
      return;
    }
    if (!emergency) {
      setChildFormError("비상 연락처를 입력해 주세요.");
      return;
    }
    setChildFormBusy(true);
    try {
      const db = getFirebaseDb();
      await addDoc(collection(db, "academies", academyId, "students"), {
        parentUserId: row.id,
        name,
        age: ageNum,
        phone,
        emergencyContact: emergency,
        createdAt: serverTimestamp(),
      });
      setNotice("자녀(학생)를 등록했습니다.");
      setChildModalOpen(false);
    } catch (e) {
      setChildFormError(callableErr(e));
    } finally {
      setChildFormBusy(false);
    }
  }, [
    academyId,
    childFormAge,
    childFormEmergency,
    childFormName,
    childFormPhone,
    childStudentCount,
    row.id,
    setNotice,
  ]);

  const run = async (action: string, name: string, exec: () => Promise<unknown>) => {
    setNotice(null);
    setBusyKey(k(action));
    try {
      await exec();
      setNotice(`${name} 처리되었습니다.`);
    } catch (e) {
      setNotice(callableErr(e));
    } finally {
      setBusyKey(null);
    }
  };

  const confirmDeleteParent = () => {
    setNotice(null);
    setBusyKey(k("del"));
    void (async () => {
      try {
        const del = httpsCallable(fn, "deleteParentInvite");
        await del({ academyId, parentId: row.id });
        setNotice("삭제 처리되었습니다.");
        setDeleteConfirmOpen(false);
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
        <div className="flex flex-wrap gap-2" role="group" aria-label="학부모 작업">
          <button
            type="button"
            disabled={busyKey !== null}
            className={actionBtnClass}
            onClick={() => openChildModal()}
          >
            자녀 등록
          </button>
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
                const h = httpsCallable(fn, "deactivateParent");
                await h({ academyId, parentAuthUid: row.id });
              })
            }
          >
            {busyKey === k("deact") ? "…" : "비활성"}
          </button>
        </div>
      );
      break;
    case "invitation_needed":
      panel = (
        <div className="flex flex-wrap gap-2" role="group" aria-label="학부모 작업">
          <button
            type="button"
            disabled={busyKey !== null}
            className={actionBtnClass}
            onClick={() =>
              void run("inv", "초청", async () => {
                const h = httpsCallable(fn, "sendParentInvitation");
                const res = await h({ academyId, parentId: row.id });
                const data = res.data as { debugLinks?: { resetLink: string; verifyLink: string } };
                if (data?.debugLinks && typeof window !== "undefined") {
                  console.info("[emulator] 초청 링크", data.debugLinks);
                }
              })
            }
          >
            {busyKey === k("inv") ? "…" : "초청"}
          </button>
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
        </div>
      );
      break;
    case "invitation_sent":
      panel = (
        <div className="flex flex-wrap gap-2" role="group" aria-label="학부모 작업">
          <button
            type="button"
            disabled={busyKey !== null}
            className={actionBtnClass}
            onClick={() =>
              void run("resend", "초청 메일 재발송", async () => {
                const h = httpsCallable(fn, "sendParentInvitation");
                const res = await h({ academyId, parentId: row.id });
                const data = res.data as { debugLinks?: { resetLink: string; verifyLink: string } };
                if (data?.debugLinks && typeof window !== "undefined") {
                  console.info("[emulator] 초청 링크", data.debugLinks);
                }
              })
            }
          >
            {busyKey === k("resend") ? "…" : "초청 재발송"}
          </button>
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
        </div>
      );
      break;
    case "pending_registration":
      panel = (
        <div className="flex flex-wrap gap-2" role="group" aria-label="학부모 작업">
          <button
            type="button"
            disabled={busyKey !== null}
            className={actionBtnClass}
            onClick={() =>
              void run("act", "활성", async () => {
                const h = httpsCallable(fn, "activateParent");
                await h({ academyId, parentAuthUid: row.id });
              })
            }
          >
            {busyKey === k("act") ? "…" : "등록(활성)"}
          </button>
          <button type="button" disabled className={actionBtnClass}>
            수정
          </button>
          <button type="button" disabled className={actionBtnClass}>
            삭제
          </button>
        </div>
      );
      break;
    case "inactive":
      panel = (
        <div className="flex flex-wrap gap-2" role="group" aria-label="학부모 작업">
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
                const h = httpsCallable(fn, "activateParent");
                await h({ academyId, parentAuthUid: row.id });
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
      {childModalOpen ? (
        <RegisterChildModal
          parentRow={row}
          open={childModalOpen}
          busy={childFormBusy}
          error={childFormError}
          formName={childFormName}
          setFormName={setChildFormName}
          formAge={childFormAge}
          setFormAge={setChildFormAge}
          formPhone={childFormPhone}
          setFormPhone={setChildFormPhone}
          formEmergency={childFormEmergency}
          setFormEmergency={setChildFormEmergency}
          studentCount={childStudentCount}
          countLoading={childCountLoading}
          onClose={closeChildModal}
          onSubmit={() => void submitChild()}
        />
      ) : null}
      {deleteConfirmOpen ? (
        <DeleteParentConfirmModal
          row={row}
          busy={busyKey === k("del")}
          onCancel={() => {
            if (busyKey !== k("del")) setDeleteConfirmOpen(false);
          }}
          onConfirm={confirmDeleteParent}
        />
      ) : null}
    </>
  );
}

function docToRow(id: string, data: Record<string, unknown>): ParentRowVM {
  const status = (data.status as ParentRegistrationStatus) || "invitation_needed";
  const invitedAt = readFirestoreTimestamp(data.invitedAt);
  let invitationExpiresAt = readFirestoreTimestamp(data.invitationExpiresAt);
  if (!invitationExpiresAt && invitedAt && status === "invitation_sent") {
    invitationExpiresAt = Timestamp.fromMillis(invitedAt.toMillis() + PARENT_INVITE_TTL_MS);
  }
  const cc = data.childrenCount;
  const childrenCount =
    typeof cc === "number" && Number.isFinite(cc) ? Math.max(0, Math.floor(cc)) : 0;
  return {
    id,
    name: typeof data.displayName === "string" ? data.displayName : "",
    email: typeof data.email === "string" ? data.email : "",
    status,
    phone: (data.phone as string | null) ?? null,
    emergencyContact: (data.emergencyContact as string | null) ?? null,
    childrenCount,
    authUid: typeof data.authUid === "string" ? data.authUid : null,
    invitationExpiresAt,
  };
}

export function AcademyParentPanel({ academyId }: { academyId: string }) {
  const [queryText, setQueryText] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [expandedParentId, setExpandedParentId] = useState<string | null>(null);
  const [rows, setRows] = useState<ParentRowVM[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  useBodyScrollLock(registerOpen);
  const [formEmail, setFormEmail] = useState("");
  const [formName, setFormName] = useState("");
  const [formEmergencyContact, setFormEmergencyContact] = useState("");
  const [formChildrenCount, setFormChildrenCount] = useState("0");
  const [formPhone, setFormPhone] = useState("");
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    const db = getFirebaseDb();
    const qy = query(
      collection(db, "academies", academyId, "parents"),
      orderBy("createdAt", "desc"),
    );
    const unsub = onSnapshot(
      qy,
      (snap) => {
        setListError(null);
        setRows(
          snap.docs.map((d) => docToRow(d.id, d.data() as Record<string, unknown>)),
        );
      },
      (err) => setListError(err.message || "목록을 불러오지 못했습니다."),
    );
    return () => unsub();
  }, [academyId]);

  useEffect(() => {
    setSelected((prev) => new Set([...prev].filter((id) => rows.some((r) => r.id === id))));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    if (!q) {
      return rows;
    }
    return rows.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.email.toLowerCase().includes(q) ||
        (t.phone ?? "").toLowerCase().includes(q) ||
        (t.emergencyContact ?? "").toLowerCase().includes(q),
    );
  }, [rows, queryText]);

  const inviteSelectedCount = useMemo(() => {
    return rows.filter((t) => selected.has(t.id) && t.status === "invitation_needed").length;
  }, [rows, selected]);

  useEffect(() => {
    if (
      expandedParentId &&
      !filtered.some((row) => row.id === expandedParentId)
    ) {
      setExpandedParentId(null);
    }
  }, [filtered, expandedParentId]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const onRegister = useCallback(async () => {
    setFormError(null);
    const email = formEmail.trim().toLowerCase();
    const name = formName.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFormError("유효한 이메일을 입력해 주세요.");
      return;
    }
    if (!name) {
      setFormError("이름을 입력해 주세요.");
      return;
    }
    const childrenCount = Number.parseInt(formChildrenCount.trim(), 10);
    if (!Number.isFinite(childrenCount) || childrenCount < 0 || childrenCount > 50) {
      setFormError("자녀 수는 0~50 사이 정수로 입력해 주세요.");
      return;
    }
    setFormBusy(true);
    try {
      const reg = httpsCallable(getFirebaseFunctions(), "registerParentInvite");
      await reg({
        academyId,
        email,
        displayName: name,
        phone: formPhone.trim() || undefined,
        emergencyContact: formEmergencyContact.trim() || undefined,
        childrenCount,
      });
      setRegisterOpen(false);
      setFormEmail("");
      setFormName("");
      setFormEmergencyContact("");
      setFormChildrenCount("0");
      setFormPhone("");
      setNotice("학부모가 초청 필요 상태로 등록되었습니다.");
    } catch (e) {
      setFormError(callableErr(e));
    } finally {
      setFormBusy(false);
    }
  }, [academyId, formEmail, formName, formPhone, formEmergencyContact, formChildrenCount]);

  const onBulkInvite = useCallback(async () => {
    if (inviteSelectedCount === 0) {
      return;
    }
    setNotice(null);
    setBulkBusy(true);
    const fn = getFirebaseFunctions();
    const send = httpsCallable(fn, "sendParentInvitation");
    const ids = rows.filter((t) => selected.has(t.id) && t.status === "invitation_needed").map((t) => t.id);
    try {
      for (const parentId of ids) {
        const res = await send({ academyId, parentId });
        const data = res.data as { debugLinks?: { resetLink: string; verifyLink: string } };
        if (data?.debugLinks && typeof window !== "undefined") {
          console.info("[emulator] 초청 링크", parentId, data.debugLinks);
        }
      }
      setSelected(new Set());
      setNotice(`${ids.length}명에게 초청 메일을 발송했습니다.`);
    } catch (e) {
      setNotice(callableErr(e));
    } finally {
      setBulkBusy(false);
    }
  }, [academyId, inviteSelectedCount, rows, selected]);

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
        <h2 className="text-sm font-semibold text-foreground">학부모 관리</h2>
        <button
          type="button"
          onClick={() => {
            setFormError(null);
            setRegisterOpen(true);
          }}
          className="shrink-0 rounded-full bg-[#222] dark:bg-neutral-100 px-3.5 py-2 text-xs font-medium text-white dark:text-neutral-950 shadow-sm hover:bg-[#333] dark:hover:bg-white"
        >
          + 학부모 등록
        </button>
      </div>

      <div className="flex gap-2">
        <input
          type="search"
          className={inputClass}
          placeholder="이름·이메일·연락처로 검색"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          aria-label="학부모 검색"
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
          <span className="h-2 w-2 rounded-full border border-neutral-500 bg-transparent" /> 초청필요
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full border border-dashed border-sky-500 bg-sky-500/20" />{" "}
          초청발송(24h)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-amber-400" /> 등록대기
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-red-500" /> 비활성
        </span>
      </div>

      <div className="relative space-y-2 pb-16">
        {filtered.length === 0 ? (
          <p className={`py-10 text-center text-sm text-neutral-500 ${glassCard}`}>
            {rows.length === 0 ? "등록된 학부모가 없습니다." : "검색 결과가 없습니다."}
          </p>
        ) : (
          filtered.map((t) => {
            const isOn = selected.has(t.id);
            const expanded = expandedParentId === t.id;
            return (
              <div
                key={t.id}
                className={`overflow-hidden ${glassCard} ${expanded ? "ring-1 ring-[#222]/10" : ""}`}
              >
                <div className="flex items-stretch gap-1 p-2 sm:gap-2 sm:p-3.5">
                  <label
                    className="flex min-h-10 min-w-12 shrink-0 cursor-pointer flex-col items-center justify-center rounded-2xl border border-transparent px-1 hover:bg-white/30 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#4a90e2]/40"
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={isOn}
                      onChange={() => toggle(t.id)}
                      aria-label={`${t.name} 선택`}
                      className="h-5 w-5 cursor-pointer rounded-md border-2 border-neutral-400 text-foreground accent-[#222]"
                    />
                  </label>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-2 py-2 text-left transition hover:bg-white/35 active:bg-white/45 sm:px-3"
                    aria-expanded={expanded}
                    aria-controls={`parent-actions-${t.id}`}
                    id={`parent-row-${t.id}`}
                    onClick={() =>
                      setExpandedParentId((prev) => (prev === t.id ? null : t.id))
                    }
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-foreground">{t.name}</span>
                      <span className="mt-0.5 block truncate text-xs text-neutral-500">
                        {t.email}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-neutral-500">
                        자녀 {t.childrenCount}명
                        {t.phone ? ` · ${t.phone}` : ""}
                      </span>
                      {t.status === "invitation_sent" && t.invitationExpiresAt ? (
                        <span className="mt-1 block">
                          <InvitationCountdown expiresAt={t.invitationExpiresAt} />
                        </span>
                      ) : null}
                    </span>
                    <StatusDot status={t.status} />
                  </button>
                </div>
                {expanded ? (
                  <div
                    id={`parent-actions-${t.id}`}
                    role="region"
                    aria-labelledby={`parent-row-${t.id}`}
                    className="border-t border-white/60 bg-white/20 px-3 py-3 sm:px-4"
                  >
                    <AcademyParentStudentList
                      academyId={academyId}
                      parentUserId={t.id}
                      setNoticeAction={setNotice}
                    />
                    <div className="mb-3 space-y-1 text-[11px] text-neutral-600">
                      {t.emergencyContact ? (
                        <p>
                          <span className="font-medium text-neutral-500">비상연락</span>{" "}
                          {t.emergencyContact}
                        </p>
                      ) : (
                        <p className="text-neutral-400">비상연락처 없음</p>
                      )}
                    </div>
                    <ParentRowActions
                      academyId={academyId}
                      row={t}
                      busyKey={busyKey}
                      setBusyKey={setBusyKey}
                      setNotice={setNotice}
                    />
                  </div>
                ) : null}
              </div>
            );
          })
        )}

        {inviteSelectedCount > 0 ? (
          <div className="pointer-events-none fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] left-1/2 z-[21] w-[min(calc(100%-2rem),20rem)] -translate-x-1/2 px-4">
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => void onBulkInvite()}
              className="pointer-events-auto w-full rounded-full bg-[#222] dark:bg-neutral-100 py-3.5 text-center text-sm font-semibold text-white dark:text-neutral-950 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.45)] hover:bg-[#333] dark:hover:bg-white disabled:opacity-60"
            >
              {bulkBusy ? "발송 중…" : `초청 메일 발송 (${inviteSelectedCount})`}
            </button>
          </div>
        ) : null}
      </div>

      {registerOpen ? (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/30 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reg-parent-title"
        >
          <div
            className={`w-full max-w-md max-h-[min(36rem,calc(100dvh-2rem))] min-h-0 overflow-y-auto p-6 ${glassCard}`}
          >
            <h3 id="reg-parent-title" className="text-lg font-semibold text-foreground">
              학부모 등록
            </h3>
            <p className="mt-1 text-xs text-neutral-500">
              등록 후 &quot;초청필요&quot; 상태로 표시됩니다. 초청 시 Firebase 계정이 만들어지고 메일이
              발송되며, 발송 시점부터 <strong>24시간</strong> 안에 학부모께서 절차를 마쳐야 합니다.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="p-email">
                  이메일 (필수)
                </label>
                <input
                  id="p-email"
                  type="email"
                  className={inputClass}
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  autoComplete="email"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="p-name">
                  이름 (필수)
                </label>
                <input
                  id="p-name"
                  className={inputClass}
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  maxLength={60}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="p-phone">
                  연락처 (선택)
                </label>
                <input
                  id="p-phone"
                  className={inputClass}
                  value={formPhone}
                  onChange={(e) => setFormPhone(e.target.value)}
                  maxLength={30}
                  inputMode="tel"
                />
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-600"
                  htmlFor="p-emergency"
                >
                  비상연락처 (선택)
                </label>
                <input
                  id="p-emergency"
                  className={inputClass}
                  value={formEmergencyContact}
                  onChange={(e) => setFormEmergencyContact(e.target.value)}
                  maxLength={30}
                  inputMode="tel"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="p-children">
                  자녀 수 (0~50)
                </label>
                <input
                  id="p-children"
                  className={inputClass}
                  type="number"
                  min={0}
                  max={50}
                  value={formChildrenCount}
                  onChange={(e) => setFormChildrenCount(e.target.value)}
                />
              </div>
              {formError ? <p className="text-sm text-red-700">{formError}</p> : null}
            </div>
            <div className="mt-6 flex gap-2">
              <button
                type="button"
                onClick={() => setRegisterOpen(false)}
                className="flex-1 rounded-2xl border border-neutral-300/70 py-3 text-sm font-medium text-foreground"
              >
                취소
              </button>
              <button
                type="button"
                disabled={formBusy}
                onClick={() => void onRegister()}
                className="flex-1 rounded-2xl bg-[#222] dark:bg-neutral-100 py-3 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-60"
              >
                {formBusy ? "등록 중…" : "등록"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
