"use client";

import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModalPortal } from "@/components/ui/modal-portal";
import { StudentAttendanceTab } from "@/components/academy/student-detail/student-attendance-tab";
import { StudentBillingTab } from "@/components/academy/student-detail/student-billing-tab";
import { StudentDeleteDialog } from "@/components/academy/student-detail/student-delete-dialog";
import {
  StudentFormSheet,
  type StudentNoteState,
} from "@/components/academy/student-detail/student-form-sheet";
import { StudentInfoTab } from "@/components/academy/student-detail/student-info-tab";
import {
  AttendanceCancelDialog,
  type AttendanceCancelTarget,
} from "@/components/academy/attendance/attendance-cancel-dialog";
import {
  attendanceActionErrorMessage,
  attendanceActionMessage,
  type AttendanceActionResult,
} from "@/lib/academy/attendance-records";
import { arrivalCancelBlock, formatSeoulHHmm } from "@/lib/academy/attendance-rules";
import { useAttendanceActions } from "@/lib/academy/use-attendance-actions";
import {
  useSeoulToday,
  useStudentTodayArrival,
  type TodayArrival,
} from "@/lib/academy/use-class-today-attendance";
import { ABSENCE_REASON_LABELS, isAbsenceReason } from "@/lib/firebase/attn-schema";
import { docToStudent, type StudentVM } from "@/lib/academy/student-row";
import { STUDENT_STATUS_LABELS, type StudentStatus } from "@/lib/academy/student-profile";
import { useAcademyClasses } from "@/lib/academy/use-academy-classes";
import { useAcademyOptionList } from "@/lib/academy/use-academy-option-list";
import type { AcademyPermissionState } from "@/lib/academy/use-permissions";
import {
  isStudentDetailTab,
  useStudentAccess,
  type StudentDetailTab,
} from "@/lib/academy/use-student-access";
import { getFirebaseDb, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

const TAB_LABELS: Record<StudentDetailTab, string> = {
  info: "정보",
  attendance: "출결",
  billing: "결제",
};

export const STUDENT_STATUS_BADGE_CLASS: Record<StudentStatus, string> = {
  enrolled: "bg-emerald-500/15 text-emerald-900",
  prospect: "bg-sky-500/15 text-sky-900",
  on_leave: "bg-amber-500/20 text-amber-950",
  withdrawn: "bg-neutral-500/15 text-neutral-700",
};

type StudentLoad =
  | { state: "loading" }
  | { state: "ok"; student: StudentVM }
  /** 문서 없음·읽기 권한 없음 — 존재 여부를 드러내지 않는 같은 문구 */
  | { state: "missing" }
  /** 네트워크 등 그 밖의 읽기 오류 — 다시 시도 */
  | { state: "error" };

/** 권한 거부·문서 없음은 "missing", 그 밖의 오류는 "error"(다시 시도) */
function loadFailureState(e: unknown): "missing" | "error" {
  return e && typeof e === "object" && "code" in e && e.code === "permission-denied" ? "missing" : "error";
}

export type StudentDetailSheetProps = {
  academyId: string;
  /** `useStudentDetailParam().studentId` */
  studentId: string;
  /** `useStudentDetailParam().tabParam` — 권한 없는 탭·모르는 값이면 시트가 정보 탭으로 바꾼다 */
  tabParam: string | null;
  /** 학원 화면은 `useAcademyShell().permissions`, 선생님 화면은 `usePermissions(academyId)` */
  permissions: Pick<AcademyPermissionState, "can" | "viewer" | "loading">;
  onTabChangeAction: (tab: StudentDetailTab) => void;
  onCloseAction: () => void;
  /** 정보 저장·삭제 뒤(목록 새로고침·안내) — 삭제면 시트는 스스로 닫힌다 */
  onChangedAction?: (message: string) => void;
};

/**
 * 학생 상세 전체 화면 시트(9-1) — 어느 화면이든 `useStudentDetailParam()` + 이 시트만 두면 된다.
 * 헤더(이름·학년·상태·반·등원 알림·⋯) + 탭(정보·출결·결제). 탭은 처음 열 때 읽고, 권한 없는 탭은 숨긴다.
 * 노출 판단은 모두 `studentAccess`(4-4절). 학생 문서를 읽지 못하면(없음·권한 없음) 같은 안내를 보여 준다.
 */
export function StudentDetailSheet({
  academyId,
  studentId,
  tabParam,
  permissions,
  onTabChangeAction,
  onCloseAction,
  onChangedAction,
}: StudentDetailSheetProps) {
  useBodyScrollLock(true);
  const access = useStudentAccess(permissions);
  const [load, setLoad] = useState<StudentLoad>({ state: "loading" });
  /** 읽기 오류 뒤 "다시 시도" */
  const [loadKey, setLoadKey] = useState(0);
  const [note, setNote] = useState<StudentNoteState | "loading">("loading");
  const [noteKey, setNoteKey] = useState(0);
  const [visited, setVisited] = useState<Set<StudentDetailTab>>(() => new Set(["info"]));
  const [menuOpen, setMenuOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { items: relations, save: saveRelations } = useAcademyOptionList(academyId, "guardianRelations");
  const { classes } = useAcademyClasses(academyId, access.readClasses);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    setLoad({ state: "loading" });
    const ref = doc(getFirebaseDb(), "academies", academyId, "students", studentId);
    const apply = (snap: { exists: () => boolean; id: string; data: () => unknown }) =>
      setLoad(
        snap.exists()
          ? { state: "ok", student: docToStudent(snap.id, snap.data() as Record<string, unknown>) }
          : { state: "missing" },
      );
    // 한 번 읽어 볼 수 있는 문서일 때만 실시간 구독한다. 규칙이 거부하는 문서(다른 반 학생 주소 등)를
    // 바로 onSnapshot하면 Firestore SDK 12.x가 내부 오류(INTERNAL ASSERTION FAILED ca9/b815)로 멈춘다(2-F QA).
    getDoc(ref).then(
      (snap) => {
        if (cancelled) return;
        apply(snap);
        if (!snap.exists()) return;
        unsubscribe = onSnapshot(ref, apply, (e) => setLoad({ state: loadFailureState(e) }));
      },
      (e: unknown) => {
        if (!cancelled) setLoad({ state: loadFailureState(e) });
      },
    );
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [academyId, studentId, loadKey]);

  const { readNotes } = access;
  useEffect(() => {
    if (!readNotes) return;
    let cancelled = false;
    setNote("loading");
    getDoc(doc(getFirebaseDb(), "academies", academyId, "studentNotes", studentId)).then(
      (snap) => {
        if (!cancelled) setNote({ loaded: true, memo: typeof snap.get("memo") === "string" ? snap.get("memo") : "" });
      },
      () => {
        if (!cancelled) setNote({ loaded: false });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [academyId, studentId, readNotes, noteKey]);

  const showNotice = useCallback((message: string | null) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    if (message) noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const student = load.state === "ok" ? load.student : null;
  const tabs = useMemo(() => (student ? access.tabs(student) : []), [access, student]);
  const activeTab: StudentDetailTab =
    isStudentDetailTab(tabParam) && tabs.includes(tabParam) ? tabParam : "info";

  // 권한 없는 탭·모르는 값으로 들어오면 정보 탭으로(그 탭 데이터는 읽지 않음)
  useEffect(() => {
    if (permissions.loading || !student || tabParam === null) return;
    if (!isStudentDetailTab(tabParam) || !tabs.includes(tabParam)) onTabChangeAction("info");
  }, [permissions.loading, student, tabParam, tabs, onTabChangeAction]);

  useEffect(() => {
    setVisited((prev) => (prev.has(activeTab) ? prev : new Set(prev).add(activeTab)));
  }, [activeTab]);

  // 2-J 오늘 등원 기록 + 취소 — 등원 처리 권한(출결 권한·담당)일 때만 구독(규칙의 등원 기록 읽기에 포함)
  const today = useSeoulToday();
  const todayEnabled = Boolean(student && access.canMarkArrival(student));
  const todayState = useStudentTodayArrival({
    academyId,
    studentId,
    date: today.date,
    enabled: todayEnabled,
    withClassRecords: access.attendanceTab,
  });
  const [cancelTarget, setCancelTarget] = useState<AttendanceCancelTarget | null>(null);
  const onCancelDone = useCallback((message: string) => showNotice(message), [showNotice]);
  const { cancelArrival } = useAttendanceActions(academyId, onCancelDone);

  const childOpen = formOpen || deleteOpen || cancelTarget !== null;
  /** 수정 시트는 메모 읽기가 끝난 뒤(성공·실패)에만 연다 — 읽는 중에 열면 메모 기준값이 비어 저장 때 덮어쓸 수 있음 */
  const noteReady = !readNotes || note !== "loading";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || childOpen) return;
      if (menuOpen) setMenuOpen(false);
      else onCloseAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [childOpen, menuOpen, onCloseAction]);

  const sendPresent = async () => {
    if (!student) return;
    setNotifyBusy(true);
    try {
      // 등원 처리(2-I) — 이미 등원이면 기록·알림 그대로 "이미 등원으로 기록되어 있습니다"
      const res = await httpsCallable(getFirebaseFunctions(), "recordStudentArrival")({
        academyId,
        studentId: student.id,
        status: "present",
        via: "student_detail",
        date: today.date,
      });
      showNotice(attendanceActionMessage("등원", res.data as AttendanceActionResult));
    } catch (e) {
      showNotice(attendanceActionErrorMessage(e));
    } finally {
      setNotifyBusy(false);
    }
  };

  const classChips = student
    ? student.classIds.flatMap((id) => {
        const c = classes.find((x) => x.id === id);
        return c ? [c] : [];
      })
    : [];

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[200] flex flex-col bg-background"
        role="dialog"
        aria-modal="true"
        aria-labelledby="student-detail-title"
      >
        <header className="shrink-0 border-b border-neutral-200/80 px-4 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="mx-auto max-w-lg">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={onCloseAction}
                className="-ml-1 rounded-full px-1 py-1 text-sm text-neutral-500 hover:text-foreground"
                aria-label="닫기"
              >
                ← 닫기
              </button>
              {student && access.manage ? (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setMenuOpen((v) => !v)}
                    className="rounded-full px-3 py-1 text-lg leading-none text-neutral-600 hover:bg-black/[0.05]"
                    aria-label="원생 메뉴"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                  >
                    ⋯
                  </button>
                  {menuOpen ? (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden />
                      <div
                        role="menu"
                        className="absolute right-0 z-20 mt-1 w-36 overflow-hidden rounded-2xl border border-neutral-200 bg-white py-1 shadow-xl"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          disabled={!noteReady}
                          className="block w-full px-4 py-2.5 text-left text-sm hover:bg-black/[0.04] disabled:text-neutral-400 disabled:hover:bg-transparent"
                          onClick={() => {
                            setMenuOpen(false);
                            setFormOpen(true);
                          }}
                        >
                          {noteReady ? "정보 수정" : "정보 수정 (불러오는 중)"}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="block w-full px-4 py-2.5 text-left text-sm text-red-600 hover:bg-red-50"
                          onClick={() => {
                            setMenuOpen(false);
                            setDeleteOpen(true);
                          }}
                        >
                          원생 삭제
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>

            {student ? (
              <>
                <div className="mt-1 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h1 id="student-detail-title" className="truncate text-xl font-semibold text-foreground">
                      {student.name || "(이름 없음)"}
                    </h1>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {student.gradeLabel ? (
                        <span className="text-xs text-neutral-600">{student.gradeLabel}</span>
                      ) : null}
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STUDENT_STATUS_BADGE_CLASS[student.status]}`}
                      >
                        {STUDENT_STATUS_LABELS[student.status]}
                      </span>
                      {classChips.map((c) => (
                        <span
                          key={c.id}
                          className="rounded-full border border-neutral-300/70 px-2 py-0.5 text-[10px] text-neutral-700"
                        >
                          {c.name}
                          {c.status === "ended" ? " (종강)" : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                  {access.notifyPresent(student) ? (
                    <button
                      type="button"
                      disabled={notifyBusy}
                      onClick={() => void sendPresent()}
                      className="shrink-0 rounded-2xl bg-[#222] px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
                    >
                      {notifyBusy ? "전송 중…" : "등원 알림"}
                    </button>
                  ) : null}
                </div>
                {/* 등원 기록 구독 오류면 줄 전체를 숨김(마지막 값이 남지 않게) */}
                {todayEnabled && !todayState.error && todayState.arrival ? (
                  <StudentTodayArrivalLine
                    arrival={todayState.arrival}
                    classRecordCount={todayState.classRecords?.length ?? 0}
                    classRecordsLoading={todayState.classRecordsLoading}
                    onCancelAction={() => {
                      const a = todayState.arrival;
                      if (!a) return;
                      setCancelTarget({
                        kind: "arrival",
                        studentId: student.id,
                        studentName: student.name,
                        status: a.status,
                        reason: a.reason,
                        billed: a.billed,
                        knownClassRecords: todayState.classRecords ?? [],
                      });
                    }}
                  />
                ) : null}
                {tabs.length > 1 ? (
                  <nav className="mt-3 flex gap-1" role="tablist" aria-label="원생 상세">
                    {tabs.map((t) => (
                      <button
                        key={t}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === t}
                        onClick={() => onTabChangeAction(t)}
                        className={`flex-1 border-b-2 py-2.5 text-sm font-medium transition ${
                          activeTab === t
                            ? "border-[#222] text-foreground"
                            : "border-transparent text-neutral-500 hover:text-foreground"
                        }`}
                      >
                        {TAB_LABELS[t]}
                      </button>
                    ))}
                  </nav>
                ) : (
                  <div className="h-3" />
                )}
              </>
            ) : (
              <h1 id="student-detail-title" className="mt-1 pb-3 text-xl font-semibold text-foreground">
                원생 정보
              </h1>
            )}
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-lg px-4 py-4">
            {notice ? (
              <p
                className="mb-3 break-keep rounded-2xl bg-emerald-500/10 px-3 py-2 text-center text-xs text-emerald-900 ring-1 ring-emerald-500/20"
                role="status"
              >
                {notice}
              </p>
            ) : null}
            {load.state === "loading" ? (
              <p className="py-12 text-center text-sm text-neutral-400">불러오는 중…</p>
            ) : load.state === "error" ? (
              <div className="py-12 text-center">
                <p className="break-keep text-sm text-red-800">원생 정보를 불러오지 못했습니다.</p>
                <div className="mt-4 flex justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => setLoadKey((k) => k + 1)}
                    className="rounded-2xl bg-[#222] px-4 py-2 text-sm font-medium text-white"
                  >
                    다시 시도
                  </button>
                  <button
                    type="button"
                    onClick={onCloseAction}
                    className="rounded-2xl border border-neutral-300/80 px-4 py-2 text-sm"
                  >
                    닫기
                  </button>
                </div>
              </div>
            ) : load.state === "missing" || !student ? (
              <div className="py-12 text-center">
                <p className="break-keep text-sm text-neutral-600">원생 정보를 찾을 수 없거나 볼 권한이 없습니다.</p>
                <button
                  type="button"
                  onClick={onCloseAction}
                  className="mt-4 rounded-2xl border border-neutral-300/80 px-4 py-2 text-sm"
                >
                  닫기
                </button>
              </div>
            ) : (
              <>
                <div hidden={activeTab !== "info"}>
                  <StudentInfoTab
                    student={student}
                    relations={relations}
                    note={access.readNotes ? note : null}
                  />
                </div>
                {visited.has("attendance") && tabs.includes("attendance") ? (
                  <div hidden={activeTab !== "attendance"}>
                    <StudentAttendanceTab
                      academyId={academyId}
                      studentId={student.id}
                      studentName={student.name}
                      canRecord={access.recordAbsence}
                      onNoticeAction={showNotice}
                    />
                  </div>
                ) : null}
                {visited.has("billing") && tabs.includes("billing") ? (
                  <div hidden={activeTab !== "billing"}>
                    <StudentBillingTab
                      academyId={academyId}
                      student={student}
                      access={access}
                      onNoticeAction={showNotice}
                    />
                  </div>
                ) : null}
              </>
            )}
          </div>
        </main>
      </div>

      {formOpen && student && noteReady ? (
        <StudentFormSheet
          academyId={academyId}
          target={student}
          note={readNotes && note !== "loading" ? note : { loaded: false }}
          relations={relations}
          onSaveRelationsAction={access.manage ? saveRelations : undefined}
          onCloseAction={() => setFormOpen(false)}
          onSavedAction={(message) => {
            setFormOpen(false);
            setNoteKey((k) => k + 1);
            showNotice(message);
            onChangedAction?.(message);
          }}
        />
      ) : null}
      {deleteOpen && student ? (
        <StudentDeleteDialog
          academyId={academyId}
          student={student}
          onCancelAction={() => setDeleteOpen(false)}
          onDeletedAction={(message) => {
            setDeleteOpen(false);
            onChangedAction?.(message);
            onCloseAction();
          }}
        />
      ) : null}
      {cancelTarget ? (
        <AttendanceCancelDialog
          target={cancelTarget}
          onConfirmAction={() =>
            cancelArrival({
              studentId: cancelTarget.studentId,
              status: cancelTarget.status,
              date: today.date,
              via: "student_detail",
            })
          }
          onCloseAction={() => setCancelTarget(null)}
        />
      ) : null}
    </ModalPortal>
  );
}

/**
 * 학생 상세 헤더 아래 "오늘" 줄(2-J) — 오늘 등원 기록과 취소. 질병·학원 사정 미등원·차감 반영일은 버튼 없이 안내만
 * (서버도 거부). 반 출결이 있는 날은 버튼을 누르면 확인 창이 이유를 보여 준다(권한 없는 담당 선생님은 서버 문구).
 */
function StudentTodayArrivalLine({
  arrival,
  classRecordCount,
  classRecordsLoading,
  onCancelAction,
}: {
  arrival: NonNullable<TodayArrival>;
  classRecordCount: number;
  /** 출결 권한자 시트에서 그날 반 출결 수를 아직 읽는 중 — 다 읽을 때까지 버튼을 막음 */
  classRecordsLoading: boolean;
  onCancelAction: () => void;
}) {
  const time = arrival.arrivedAtMs ? ` ${formatSeoulHHmm(new Date(arrival.arrivedAtMs))}` : "";
  const reasonLabel =
    arrival.status === "absent" && isAbsenceReason(arrival.reason) && arrival.reason !== "general"
      ? `(${ABSENCE_REASON_LABELS[arrival.reason]})`
      : "";
  const label = arrival.status === "present" ? `오늘 등원${time}` : `오늘 미등원${reasonLabel}`;
  const block = arrivalCancelBlock({
    status: arrival.status,
    reason: arrival.reason,
    billed: arrival.billed,
    classRecordCount,
  });
  return (
    <div className="mt-2 flex items-center gap-2 rounded-xl bg-black/[0.03] px-3 py-1.5 text-[11px]">
      <span className="min-w-0 flex-1 break-keep text-neutral-700">{label}</span>
      {block === "reason_locked" ? (
        <span className="shrink-0 break-keep text-neutral-500">출결 탭에서 정정</span>
      ) : block === "billed" ? (
        <span className="shrink-0 break-keep text-neutral-500">차감 반영일</span>
      ) : (
        <button
          type="button"
          disabled={classRecordsLoading}
          onClick={onCancelAction}
          className="shrink-0 rounded-[8px] border border-neutral-300/80 bg-white/70 px-2.5 py-1 font-medium text-neutral-800 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {arrival.status === "present" ? "등원 취소" : "미등원 취소"}
        </button>
      )}
    </div>
  );
}
