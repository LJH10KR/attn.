"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import {
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TuitionType } from "@/lib/firebase/attn-schema";
import { getFirebaseDb, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { useAcademyShell } from "@/components/academy/academy-shell";
import { SessionLogModal } from "@/components/academy/session-log-modal";
import { AbsenceRecordModal } from "@/components/academy/absence-record-modal";
import { AttendanceHistoryModal } from "@/components/academy/attendance-history-modal";
import { TuitionInvoiceModal } from "@/components/academy/tuition-invoice-modal";
import {
  chargeStudentSessions,
  ChargeSessionModal,
  recordStudentSessionComplete,
  SessionCompleteConfirmModal,
  TuitionSettingModal,
} from "@/components/academy/student-detail/billing-modals";
import {
  attendanceButtonErrorMessage,
  attendanceButtonResultMessage,
  type AttendanceNotifyResult,
} from "@/lib/academy/attendance-records";
import { useAcademyListPoll } from "@/lib/firebase/use-academy-list-poll";
import { cachedRead } from "@/lib/firebase/cached-read";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";
import { KrPhoneInput } from "@/components/ui/kr-phone-input";
import { formatKrPhoneDisplay } from "@/lib/phone/kr-phone";
import {
  displayGrade,
  gradeLabel,
  normalizeStudentStatus,
  type StudentStatus,
} from "@/lib/academy/student-profile";
import { useStudentAccess } from "@/lib/academy/use-student-access";

/**
 * 예전 원생 패널에서 남은 부분 — 원생 관리 화면은 2-E에서 `operations/students`(학생 상세 시트)로 바뀌었다.
 * 남은 사용처: `AcademyParentStudentList`(예전 학부모 패널, 2-G 교체), `StudentRowVM`·`docToStudentRow`
 * (`/teacher` 2-F, `/parent`·학부모 출석 PIN 카드 2-G). 사용처가 0이 되면 2-H에서 파일째 삭제.
 */

const glassCard = "glass-card";

const inputClass =
  "min-w-0 w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-2.5 text-sm text-foreground shadow-inner outline-none placeholder:text-neutral-400 focus:border-[#4a90e2]/50 focus:bg-white/70";

const miniBtnClass =
  "rounded-[8px] border border-neutral-300/70 bg-white/55 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-white/90 disabled:opacity-45";

export type StudentRowVM = {
  id: string;
  /** 연결된 보호자 앱 계정(서버 계산) — 2-E에서 새 원생 화면으로 교체 */
  parentUids: string[];
  name: string;
  /** 표시 학년(초3 등) */
  gradeLabel: string;
  /** @deprecated 예전 나이 필드 — 2-E에서 학년으로 교체되며 삭제 */
  age: number;
  phone: string;
  emergencyContact: string;
  /** 반 담당 선생님(서버가 반에서 계산) */
  teacherUids: string[];
  /** 원생 상태(값이 없으면 재원) — 출석 알림 노출 판단 */
  status: StudentStatus;
  createdAt?: Timestamp;
  /** 매월 지정일 납부 */
  tuitionDueDayOfMonth?: number | null;
  tuitionAmount?: number | null;
  /** 회차 방식 납부 */
  tuitionType?: TuitionType | null;
  weeklySessionCount?: number | null;
  pricePerSession?: number | null;
  sessionBalance?: number | null;
  /** 학부모가 납부 안내 알림을 확인한 시각 */
  tuitionReminderConfirmedAt?: Timestamp | null;
  /** 학생별 결석 1일 차감액 — 없으면 학원 기본값 */
  absenceDeductionPerDay?: number | null;
};

function fsErr(err: unknown): string {
  if (err instanceof FirebaseError) {
    return err.message || "요청에 실패했습니다.";
  }
  return "요청에 실패했습니다.";
}

export function docToStudentRow(id: string, data: Record<string, unknown>): StudentRowVM {
  const ageRaw = data.age;
  const age =
    typeof ageRaw === "number" && Number.isFinite(ageRaw)
      ? Math.max(0, Math.floor(ageRaw))
      : 0;
  const createdAt = data.createdAt;

  const rawDueDayOfMonth = data.tuitionDueDayOfMonth;
  const tuitionDueDayOfMonth =
    typeof rawDueDayOfMonth === "number" &&
    Number.isInteger(rawDueDayOfMonth) &&
    rawDueDayOfMonth >= 1 &&
    rawDueDayOfMonth <= 31
      ? rawDueDayOfMonth
      : null;

  const rawTuitionType = data.tuitionType;
  const tuitionType: TuitionType | null =
    rawTuitionType === "monthly_fixed" || rawTuitionType === "session_based"
      ? rawTuitionType
      : null;

  const rawWeeklyCount = data.weeklySessionCount;
  const weeklySessionCount =
    typeof rawWeeklyCount === "number" &&
    Number.isInteger(rawWeeklyCount) &&
    rawWeeklyCount >= 1 &&
    rawWeeklyCount <= 7
      ? rawWeeklyCount
      : null;

  const rawPrice = data.pricePerSession;
  const pricePerSession =
    typeof rawPrice === "number" && rawPrice >= 0 ? rawPrice : null;

  const rawBalance = data.sessionBalance;
  const sessionBalance =
    typeof rawBalance === "number" && Number.isInteger(rawBalance) ? rawBalance : null;

  const rawConfirmedAt = data.tuitionReminderConfirmedAt;
  const tuitionReminderConfirmedAt =
    rawConfirmedAt &&
    typeof rawConfirmedAt === "object" &&
    "toMillis" in rawConfirmedAt &&
    typeof (rawConfirmedAt as Timestamp).toMillis === "function"
      ? (rawConfirmedAt as Timestamp)
      : null;

  return {
    id,
    parentUids: Array.isArray(data.parentUids)
      ? data.parentUids.filter((x): x is string => typeof x === "string")
      : [],
    name: typeof data.name === "string" ? data.name : "",
    gradeLabel:
      typeof data.gradeLabel === "string"
        ? data.gradeLabel
        : gradeLabel(displayGrade(data.grade, data.gradeYear)),
    age,
    phone: typeof data.phone === "string" ? data.phone : "",
    emergencyContact: typeof data.emergencyContact === "string" ? data.emergencyContact : "",
    status: normalizeStudentStatus(data.status),
    teacherUids: Array.isArray(data.teacherUids)
      ? data.teacherUids.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [],
    createdAt:
      createdAt &&
      typeof createdAt === "object" &&
      "toMillis" in createdAt &&
      typeof (createdAt as Timestamp).toMillis === "function"
        ? (createdAt as Timestamp)
        : undefined,
    tuitionDueDayOfMonth,
    tuitionAmount: typeof data.tuitionAmount === "number" ? data.tuitionAmount : null,
    tuitionType,
    weeklySessionCount,
    pricePerSession,
    sessionBalance,
    tuitionReminderConfirmedAt,
    absenceDeductionPerDay:
      typeof data.absenceDeductionPerDay === "number" && data.absenceDeductionPerDay > 0
        ? data.absenceDeductionPerDay
        : null,
  };
}

function sortStudentsByCreated(a: StudentRowVM, b: StudentRowVM): number {
  return (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0);
}

function ChevronRightGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EditStudentModal({
  academyId,
  student,
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
  onClose,
  onSubmit,
}: {
  academyId: string;
  student: StudentRowVM;
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
  onClose: () => void;
  onSubmit: () => void;
}) {
  useBodyScrollLock(open);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-student-title"
        className={`${glassCard} w-full max-w-md max-h-[min(90dvh,640px)] overflow-y-auto p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="edit-student-title" className="text-base font-semibold text-foreground">
          학생 정보 수정
        </h2>
        <p className="mt-1 text-xs text-neutral-700">
          대상: <span className="font-medium text-foreground">{student.name}</span>
        </p>
        <p className="mt-0.5 text-[11px] text-neutral-500">
          학원 ID: <span className="font-mono">{academyId}</span>
        </p>
        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="es-name">
              이름
            </label>
            <input
              id="es-name"
              className={inputClass}
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              maxLength={80}
              disabled={busy}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="es-age">
              나이
            </label>
            <input
              id="es-age"
              type="number"
              min={0}
              max={120}
              className={inputClass}
              value={formAge}
              onChange={(e) => setFormAge(e.target.value)}
              disabled={busy}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="es-phone">
              연락처
            </label>
            <KrPhoneInput
              id="es-phone"
              className={inputClass}
              value={formPhone}
              onChange={setFormPhone}
              disabled={busy}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="es-em">
              비상 연락처
            </label>
            <KrPhoneInput
              id="es-em"
              className={inputClass}
              value={formEmergency}
              onChange={setFormEmergency}
              disabled={busy}
            />
          </div>
        </div>
        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            ref={ref}
            type="button"
            disabled={busy}
            className="rounded-2xl border border-neutral-300/80 bg-white/80 px-4 py-2.5 text-sm font-medium text-neutral-800"
            onClick={onClose}
          >
            취소
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded-2xl bg-[#222] dark:bg-neutral-100 px-4 py-2.5 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-50"
            onClick={() => onSubmit()}
          >
            {busy ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DeleteStudentConfirmModal({
  student,
  busy,
  onCancel,
  onConfirm,
}: {
  student: StudentRowVM;
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

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="del-student-title"
        className={`${glassCard} w-full max-w-md p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="del-student-title" className="text-base font-semibold text-foreground">
          학생을 삭제할까요?
        </h2>
        <p className="mt-3 text-sm text-neutral-700">
          <span className="font-medium">{student.name}</span>
          {student.gradeLabel ? <span className="text-neutral-500"> ({student.gradeLabel})</span> : null} — 이
          정보를 삭제합니다. 되돌릴 수 없습니다.
        </p>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            className="rounded-2xl border border-neutral-300/80 bg-white/80 px-4 py-2.5 text-sm font-medium text-neutral-800 disabled:opacity-50"
            onClick={onCancel}
          >
            취소
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded-2xl bg-red-700 px-4 py-2.5 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-50"
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

/** 학부모 카드 확장 영역 — 해당 학부모의 자녀만 */
export function AcademyParentStudentList({
  academyId,
  parentUid,
  setNoticeAction,
}: {
  academyId: string;
  parentUid: string;
  setNoticeAction: (msg: string | null) => void;
}) {
  const [teacherNames, setTeacherNames] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<StudentRowVM[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<StudentRowVM | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StudentRowVM | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [formName, setFormName] = useState("");
  const [formAge, setFormAge] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formEmergency, setFormEmergency] = useState("");
  const [notifyBusyKey, setNotifyBusyKey] = useState<string | null>(null);
  const [tuitionModalTarget, setTuitionModalTarget] = useState<StudentRowVM | null>(null);
  const [sessionConfirmTarget, setSessionConfirmTarget] = useState<StudentRowVM | null>(null);
  const [sessionCompleteBusy, setSessionCompleteBusy] = useState(false);
  const [chargeTarget, setChargeTarget] = useState<StudentRowVM | null>(null);
  const [chargeBusy, setChargeBusy] = useState(false);
  const [logModalTarget, setLogModalTarget] = useState<StudentRowVM | null>(null);
  const [absenceTarget, setAbsenceTarget] = useState<StudentRowVM | null>(null);
  const [attendanceTarget, setAttendanceTarget] = useState<StudentRowVM | null>(null);
  const [invoiceTarget, setInvoiceTarget] = useState<StudentRowVM | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { permissions } = useAcademyShell();
  const studentAccessState = useStudentAccess(permissions);
  // 예전 버튼 이름 그대로 — 판단은 공용 `studentAccess`(2-G에서 이 목록째 학생 상세 시트로 교체)
  const access = {
    present: (s: StudentRowVM) => studentAccessState.notifyPresent(s),
    absence: studentAccessState.recordAbsence,
    sessionComplete: studentAccessState.sessionComplete,
    tuition: studentAccessState.tuitionEdit,
    attendance: studentAccessState.attendanceTab,
    invoice: studentAccessState.manageInvoices,
    manage: studentAccessState.manage,
  };
  /** 직원 목록 읽기(담당 선생님 이름) — staff 읽기 규칙과 같은 목록 */
  const readStaff = permissions.can(["settings.staff", "settings.members", "operations.students", "operations.classes"]);

  const loadParentChildren = useCallback(async () => {
    try {
      const db = getFirebaseDb();
      // 학부모 관리 권한만 있으면 직원 목록은 못 읽음 — 담당 선생님 이름 없이 자녀만
      const [teachersSnap, studentsSnap] = await Promise.all([
        readStaff
          ? cachedRead(`staff:${academyId}`, () =>
              getDocs(collection(db, "academies", academyId, "staff")),
            )
          : Promise.resolve(null),
        getDocs(
          query(
            collection(db, "academies", academyId, "students"),
            where("parentUids", "array-contains", parentUid),
          ),
        ),
      ]);
      const m: Record<string, string> = {};
      for (const d of teachersSnap?.docs ?? []) {
        const data = d.data() as { displayName?: string };
        m[d.id] = typeof data.displayName === "string" && data.displayName ? data.displayName : d.id;
      }
      setTeacherNames(m);
      const list = studentsSnap.docs.map((d) =>
        docToStudentRow(d.id, d.data() as Record<string, unknown>),
      );
      list.sort(sortStudentsByCreated);
      setRows(list);
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "목록을 불러오지 못했습니다.");
      setRows([]);
    }
  }, [academyId, parentUid, readStaff]);

  const { refresh: refreshParentChildren } = useAcademyListPoll(loadParentChildren, [
    academyId,
    parentUid,
  ]);

  const recordSessionComplete = useCallback(async (student: StudentRowVM) => {
    setSessionCompleteBusy(true);
    try {
      await recordStudentSessionComplete(academyId, student.id);
      setNoticeAction(`${student.name} 수업 완료 기록이 저장되었습니다.`);
      setSessionConfirmTarget(null);
      refreshParentChildren();
    } catch (e) {
      setNoticeAction(fsErr(e));
    } finally {
      setSessionCompleteBusy(false);
    }
  }, [academyId, refreshParentChildren, setNoticeAction]);

  const chargeSession = useCallback(async (student: StudentRowVM, n: number) => {
    setChargeBusy(true);
    try {
      await chargeStudentSessions(academyId, student, n);
      setNoticeAction(`${student.name}에게 ${n}회 충전했습니다.`);
      setChargeTarget(null);
      refreshParentChildren();
    } catch (e) {
      setNoticeAction(fsErr(e));
    } finally {
      setChargeBusy(false);
    }
  }, [academyId, refreshParentChildren, setNoticeAction]);

  const openEdit = (s: StudentRowVM) => {
    setEditErr(null);
    setFormName(s.name);
    setFormAge(String(s.age));
    setFormPhone(formatKrPhoneDisplay(s.phone));
    setFormEmergency(formatKrPhoneDisplay(s.emergencyContact));
    setEditTarget(s);
  };

  const closeEdit = () => {
    if (!editBusy) setEditTarget(null);
  };

  const saveEdit = useCallback(async () => {
    if (!editTarget) return;
    setEditErr(null);
    const name = formName.trim();
    if (!name || name.length > 80) {
      setEditErr("이름을 1~80자로 입력해 주세요.");
      return;
    }
    const ageNum = Number.parseInt(formAge.trim(), 10);
    if (!Number.isFinite(ageNum) || ageNum < 0 || ageNum > 120) {
      setEditErr("나이는 0~120 사이 정수로 입력해 주세요.");
      return;
    }
    const phone = formPhone.trim().slice(0, 30);
    const emergency = formEmergency.trim().slice(0, 30);
    if (!phone || !emergency) {
      setEditErr("연락처와 비상 연락처를 모두 입력해 주세요.");
      return;
    }
    setEditBusy(true);
    try {
      const db = getFirebaseDb();
      await updateDoc(doc(db, "academies", academyId, "students", editTarget.id), {
        name,
        age: ageNum,
        phone,
        emergencyContact: emergency,
        updatedAt: serverTimestamp(),
      });
      setNoticeAction("학생 정보를 저장했습니다.");
      setEditTarget(null);
      refreshParentChildren();
    } catch (e) {
      setEditErr(fsErr(e));
    } finally {
      setEditBusy(false);
    }
  }, [
    academyId,
    editTarget,
    formAge,
    formEmergency,
    formName,
    formPhone,
    setNoticeAction,
    refreshParentChildren,
  ]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDelBusy(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), "deleteAcademyStudent");
      await fn({ academyId, studentId: deleteTarget.id });
      setNoticeAction("학생을 삭제했습니다.");
      setDeleteTarget(null);
      refreshParentChildren();
    } catch (e) {
      setNoticeAction(fsErr(e));
    } finally {
      setDelBusy(false);
    }
  }, [academyId, deleteTarget, refreshParentChildren, setNoticeAction]);

  const sendAttendanceNotify = useCallback(
    async (studentId: string, kind: "present" | "absent") => {
      const key = `${studentId}-${kind}`;
      setNotifyBusyKey(key);
      try {
        const fn = httpsCallable(getFirebaseFunctions(), "sendStudentAttendanceNotification");
        const res = await fn({ academyId, studentId, kind });
        setNoticeAction(attendanceButtonResultMessage(kind, res.data as AttendanceNotifyResult));
      } catch (e) {
        setNoticeAction(attendanceButtonErrorMessage(e));
      } finally {
        setNotifyBusyKey(null);
      }
    },
    [academyId, setNoticeAction],
  );

  return (
    <div className="mb-4">
      <h4 className="mb-2 text-xs font-semibold text-foreground">자녀(학생) 목록</h4>
      {listError ? (
        <p className="text-xs text-red-600">{listError}</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-neutral-500">등록된 자녀가 없습니다.</p>
      ) : (
        <ul className="max-h-48 space-y-2 overflow-y-auto pr-1">
          {rows.map((s) => (
            <li
              key={s.id}
              className="overflow-hidden rounded-xl border border-white/60 bg-white/25 text-xs text-neutral-800"
            >
              <div className="flex items-start justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <span className="font-medium text-foreground">{s.name}</span>
                  <span className="text-neutral-500"> · {s.gradeLabel || "학년 미입력"}</span>
                  <div className="mt-0.5 text-[11px] text-neutral-600">
                    연락 {formatKrPhoneDisplay(s.phone) || "—"} · 비상{" "}
                    {formatKrPhoneDisplay(s.emergencyContact) || "—"}
                  </div>
                  {s.teacherUids.length > 0 ? (
                    <div className="mt-0.5 text-[11px] text-sky-900">
                      담당:{" "}
                      {s.teacherUids.map((uid, i) => (
                        <span key={uid}>
                          {i > 0 ? ", " : ""}
                          <span className="font-medium">{teacherNames[uid] ?? uid}</span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {s.tuitionDueDayOfMonth ? (
                    <div className="mt-0.5 text-[11px] text-amber-800">
                      납부일 매월{" "}
                      <span className="font-medium">{s.tuitionDueDayOfMonth}일</span>
                      {s.tuitionAmount != null ? (
                        <> · {s.tuitionAmount.toLocaleString("ko-KR")}원</>
                      ) : null}
                    </div>
                  ) : s.weeklySessionCount != null ? (
                    <div className="mt-0.5 text-[11px] text-violet-800">
                      회차 방식 · 주{s.weeklySessionCount}회
                      {s.pricePerSession != null ? (
                        <> · {s.pricePerSession.toLocaleString("ko-KR")}원/회</>
                      ) : null}
                      {s.sessionBalance != null ? (
                        <span className={s.sessionBalance < 0 ? " · 잔여 " : " · 잔여 "}>
                          {" "}·{" "}
                          <span className={s.sessionBalance < 0 ? "font-medium text-red-700" : "font-medium"}>
                            잔여 {s.sessionBalance}회
                          </span>
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {s.tuitionReminderConfirmedAt ? (
                    <div className="mt-0.5 text-[11px] text-emerald-700 font-medium">
                      ✓ 학부모 납부 알림 확인 완료
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {access.present(s) ? (
                    <button type="button" className={miniBtnClass} disabled={notifyBusyKey !== null} onClick={() => void sendAttendanceNotify(s.id, "present")}>
                      {notifyBusyKey === `${s.id}-present` ? "전송 중…" : "출석"}
                    </button>
                  ) : null}
                  {access.absence ? (
                    <button type="button" className={miniBtnClass} disabled={notifyBusyKey !== null} onClick={() => setAbsenceTarget(s)}>
                      결석
                    </button>
                  ) : null}
                  {s.weeklySessionCount != null ? (
                    <>
                      {access.sessionComplete ? (
                        <button type="button" className={`${miniBtnClass} border-violet-300/70 bg-violet-50/70 text-violet-800 hover:bg-violet-100`} disabled={sessionCompleteBusy || chargeBusy} onClick={() => setSessionConfirmTarget(s)}>수업 완료</button>
                      ) : null}
                      {access.tuition ? (
                        <button type="button" className="rounded-[8px] border border-violet-400/60 bg-violet-700 px-2 py-1 text-[10px] font-medium text-white hover:bg-violet-800 disabled:opacity-45" disabled={sessionCompleteBusy || chargeBusy} onClick={() => setChargeTarget(s)}>충전</button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
              {expandedId === s.id ? (
                <div className="flex flex-wrap gap-1 border-t border-white/40 px-3 py-2">
                  {access.attendance ? (
                    <button type="button" className={miniBtnClass} onClick={() => setAttendanceTarget(s)}>출결</button>
                  ) : null}
                  {access.invoice && s.tuitionDueDayOfMonth && s.tuitionAmount != null ? (
                    <button type="button" className={miniBtnClass} onClick={() => setInvoiceTarget(s)}>청구</button>
                  ) : null}
                  {s.weeklySessionCount != null ? (
                    <button type="button" className={miniBtnClass} onClick={() => setLogModalTarget(s)}>기록</button>
                  ) : null}
                  {access.tuition ? (
                    <button type="button" className={miniBtnClass} onClick={() => setTuitionModalTarget(s)}>원비</button>
                  ) : null}
                  {access.manage ? (
                    <>
                      <button type="button" className={miniBtnClass} onClick={() => { openEdit(s); setExpandedId(null); }}>수정</button>
                      <button type="button" className={`${miniBtnClass} border-red-200/80 text-red-600 hover:bg-red-50`} onClick={() => { setDeleteTarget(s); setExpandedId(null); }}>삭제</button>
                    </>
                  ) : null}
                </div>
              ) : null}
              <button
                type="button"
                className="flex w-full items-center justify-center border-t border-white/40 py-1 hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
                onClick={() => setExpandedId((prev) => (prev === s.id ? null : s.id))}
                aria-expanded={expandedId === s.id}
                aria-label="더 보기"
              >
                <ChevronRightGlyph className={`transition-transform duration-150 text-neutral-400 ${expandedId === s.id ? "-rotate-90" : "rotate-90"}`} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {editTarget ? (
        <EditStudentModal
          academyId={academyId}
          student={editTarget}
          open
          busy={editBusy}
          error={editErr}
          formName={formName}
          setFormName={setFormName}
          formAge={formAge}
          setFormAge={setFormAge}
          formPhone={formPhone}
          setFormPhone={setFormPhone}
          formEmergency={formEmergency}
          setFormEmergency={setFormEmergency}
          onClose={closeEdit}
          onSubmit={() => void saveEdit()}
        />
      ) : null}
      {deleteTarget ? (
        <DeleteStudentConfirmModal
          student={deleteTarget}
          busy={delBusy}
          onCancel={() => {
            if (!delBusy) setDeleteTarget(null);
          }}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
      {tuitionModalTarget ? (
        <TuitionSettingModal
          academyId={academyId}
          student={tuitionModalTarget}
          onClose={() => setTuitionModalTarget(null)}
          onSaved={() => {
            setNoticeAction("원비 납부일을 저장했습니다.");
            refreshParentChildren();
          }}
        />
      ) : null}
      {sessionConfirmTarget ? (
        <SessionCompleteConfirmModal
          student={sessionConfirmTarget}
          busy={sessionCompleteBusy}
          onCancel={() => { if (!sessionCompleteBusy) setSessionConfirmTarget(null); }}
          onConfirm={() => void recordSessionComplete(sessionConfirmTarget)}
        />
      ) : null}
      {chargeTarget ? (
        <ChargeSessionModal
          student={chargeTarget}
          busy={chargeBusy}
          onCancel={() => { if (!chargeBusy) setChargeTarget(null); }}
          onConfirm={(n) => void chargeSession(chargeTarget, n)}
        />
      ) : null}
      {logModalTarget ? (
        <SessionLogModal
          academyId={academyId}
          studentId={logModalTarget.id}
          studentName={logModalTarget.name}
          onClose={() => setLogModalTarget(null)}
          onCancelled={refreshParentChildren}
        />
      ) : null}
      {absenceTarget ? (
        <AbsenceRecordModal
          academyId={academyId}
          studentId={absenceTarget.id}
          studentName={absenceTarget.name}
          onClose={() => setAbsenceTarget(null)}
          onSaved={(message) => {
            setAbsenceTarget(null);
            setNoticeAction(message);
          }}
        />
      ) : null}
      {attendanceTarget ? (
        <AttendanceHistoryModal
          academyId={academyId}
          studentId={attendanceTarget.id}
          studentName={attendanceTarget.name}
          onClose={() => setAttendanceTarget(null)}
          onNotice={setNoticeAction}
        />
      ) : null}
      {invoiceTarget?.tuitionDueDayOfMonth && invoiceTarget.tuitionAmount != null ? (
        <TuitionInvoiceModal
          academyId={academyId}
          studentId={invoiceTarget.id}
          studentName={invoiceTarget.name}
          tuitionAmount={invoiceTarget.tuitionAmount}
          tuitionDueDayOfMonth={invoiceTarget.tuitionDueDayOfMonth}
          studentPerDayDeduction={invoiceTarget.absenceDeductionPerDay ?? null}
          onClose={() => setInvoiceTarget(null)}
          onNotice={setNoticeAction}
        />
      ) : null}
    </div>
  );
}

