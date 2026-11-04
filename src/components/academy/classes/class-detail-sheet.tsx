"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClassAttendanceControls,
  type ClassAttendanceAction,
} from "@/components/academy/attendance/class-attendance-controls";
import {
  CLASS_STATUS_BADGE_CLASS,
  CLASS_STATUS_LABELS,
} from "@/components/academy/classes/class-form-sheet";
import { STUDENT_STATUS_BADGE_CLASS } from "@/components/academy/student-detail/student-detail-sheet";
import { ModalPortal } from "@/components/ui/modal-portal";
import { scheduleSummary, slotsOnWeekday } from "@/lib/academy/class-schedule";
import { isActiveStudent, STUDENT_STATUS_LABELS } from "@/lib/academy/student-profile";
import { rowBusyFor, useAttendanceActions } from "@/lib/academy/use-attendance-actions";
import { useClassTodayAttendance, useSeoulToday } from "@/lib/academy/use-class-today-attendance";
import type { AcademyPermissionState } from "@/lib/academy/use-permissions";
import { useStudentAccess } from "@/lib/academy/use-student-access";
import type { StudentVM } from "@/lib/academy/student-row";
import type { AcademyClassBrief } from "@/lib/academy/use-academy-classes";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

const sectionClass = "rounded-2xl border border-neutral-200/80 bg-white/40 px-4 py-3";

/**
 * 반 상세 시트(가벼운 형태 — 0장 2-F 결정 1): 요약 정보, 원생 목록(누르면 학생 상세 시트),
 * 수정·원생 배정·삭제 버튼까지만. URL 연동·변경 이력 표시는 없음.
 * 2-I: 출결 권한·그 반 선생님이면 원생마다 오늘 출석·결석(조건이 안 맞으면 옅게 + 이유).
 * 오늘 출결 구독은 읽기 권한이 있을 때만(B1 — 반 관리 권한만 있는 직원은 버튼·구독 없음).
 */
export function ClassDetailSheet({
  academyId,
  cls,
  members,
  studentsReady,
  studentsError,
  teacherNames,
  roomLabel,
  permissions,
  escapeBlocked = false,
  onEditAction,
  onAssignAction,
  onOpenStudentAction,
  onRetryStudentsAction,
  onDeletedAction,
  onCloseAction,
}: {
  academyId: string;
  cls: AcademyClassBrief;
  /** 이 반 원생(이름순) */
  members: StudentVM[];
  /** 원생 목록 읽기 성공 — 배정 시트는 이때만 연다 */
  studentsReady: boolean;
  studentsError: string | null;
  teacherNames: string[];
  roomLabel: string | null;
  /** 학원 화면 `useAcademyShell().permissions` */
  permissions: Pick<AcademyPermissionState, "can" | "viewer">;
  escapeBlocked?: boolean;
  onEditAction: () => void;
  onAssignAction: () => void;
  onOpenStudentAction: (studentId: string) => void;
  onRetryStudentsAction: () => void;
  onDeletedAction: (message: string) => void;
  onCloseAction: () => void;
}) {
  useBodyScrollLock(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  // 오늘 출결(2-I)
  const access = useStudentAccess(permissions);
  const today = useSeoulToday();
  const viewerUid = permissions.viewer?.uid ?? null;
  const canMark = access.canMarkClass(cls);
  const ended = cls.status === "ended";
  const todaySlots = slotsOnWeekday(cls.schedule, today.weekday);
  const hasLessonToday = todaySlots.length > 0;
  const watch = canMark && access.readClassAttendance(cls) && hasLessonToday && !ended && studentsReady;
  const canReadArrival = useCallback(
    (s: StudentVM) => access.attendanceTab || (viewerUid !== null && s.teacherUids.includes(viewerUid)),
    [access.attendanceTab, viewerUid],
  );
  const arrivalIds = useMemo(
    () => (watch ? members.filter((s) => isActiveStudent(s) && canReadArrival(s)).map((s) => s.id) : []),
    [watch, members, canReadArrival],
  );
  const todayState = useClassTodayAttendance({
    academyId,
    classId: cls.id,
    date: today.date,
    enabled: watch,
    arrivalStudentIds: arrivalIds,
  });
  const onAttendanceDone = useCallback((text: string, ok: boolean) => setNotice({ text, ok }), []);
  const { busyKey, markClass } = useAttendanceActions(academyId, onAttendanceDone);
  const onAttendance = (s: StudentVM, action: ClassAttendanceAction) => {
    if (action.kind !== "class") return;
    setNotice(null);
    void markClass(cls.id, cls.name, s.id, action.status, "class_detail", s.name);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || escapeBlocked || deleting) return;
      if (confirmOpen) setConfirmOpen(false);
      else if (menuOpen) setMenuOpen(false);
      else onCloseAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [escapeBlocked, deleting, confirmOpen, menuOpen, onCloseAction]);

  const onDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await httpsCallable(getFirebaseFunctions(), "deleteClass")({ academyId, classId: cls.id });
      const n = (res.data as { removedStudentCount?: number }).removedStudentCount ?? 0;
      onDeletedAction(`${cls.name} 반을 삭제했습니다${n > 0 ? `(원생 ${n}명 해제)` : ""}.`);
    } catch (e) {
      setDeleteError(e instanceof FirebaseError && e.message ? e.message : "반을 삭제하지 못했습니다.");
      setDeleting(false);
    }
  };

  const schedule = scheduleSummary(cls.schedule);
  const info: { label: string; value: string }[] = [
    { label: "수업 시간", value: schedule || "—" },
    { label: "선생님", value: teacherNames.length > 0 ? teacherNames.join(", ") : "선생님 미지정" },
    { label: "강의실", value: roomLabel ?? (cls.roomId ? "강의실 미지정" : "—") },
    {
      label: "원생",
      value: studentsReady
        ? `${members.length}명${cls.capacity !== null ? ` / 정원 ${cls.capacity}명` : ""}`
        : "…",
    },
  ];
  const over = studentsReady && cls.capacity !== null && members.length > cls.capacity;

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[150] flex flex-col bg-background"
        role="dialog"
        aria-modal="true"
        aria-labelledby="class-detail-title"
      >
        <header className="shrink-0 border-b border-neutral-200/80 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
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
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMenuOpen((v) => !v)}
                  className="rounded-full px-3 py-1 text-lg leading-none text-neutral-600 hover:bg-black/[0.05]"
                  aria-label="반 메뉴"
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
                      className="absolute right-0 z-20 mt-1 w-32 overflow-hidden rounded-2xl border border-neutral-200 bg-white py-1 shadow-xl"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className="block w-full px-4 py-2.5 text-left text-sm text-red-600 hover:bg-red-50"
                        onClick={() => {
                          setMenuOpen(false);
                          setDeleteError(null);
                          setConfirmOpen(true);
                        }}
                      >
                        반 삭제
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <h1 id="class-detail-title" className="min-w-0 truncate text-xl font-semibold text-foreground">
                {cls.name || "(이름 없음)"}
              </h1>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${CLASS_STATUS_BADGE_CLASS[cls.status]}`}
              >
                {CLASS_STATUS_LABELS[cls.status]}
              </span>
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-lg space-y-3 px-4 py-4">
            <section className={sectionClass}>
              <dl className="space-y-1.5 text-xs">
                {info.map((row) => (
                  <div key={row.label} className="flex justify-between gap-3">
                    <dt className="shrink-0 text-neutral-500">{row.label}</dt>
                    <dd className={`min-w-0 break-keep text-right ${row.label === "원생" && over ? "font-semibold text-amber-800" : "text-foreground"}`}>
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={onEditAction}
                className="rounded-2xl border border-neutral-300/80 bg-white/60 py-2.5 text-sm font-medium text-foreground"
              >
                수정
              </button>
              <button
                type="button"
                onClick={onAssignAction}
                disabled={!studentsReady}
                className="rounded-2xl bg-[#222] py-2.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {studentsReady ? "원생 배정" : "원생 불러오는 중"}
              </button>
            </div>

            <section className={sectionClass}>
              <h2 className="mb-2 text-xs font-semibold text-foreground">
                원생 {studentsReady ? members.length : ""}
              </h2>
              {canMark ? (
                <p className="-mt-1 mb-2 break-keep text-[11px] text-neutral-500">
                  {ended
                    ? "종강한 반이라 출결을 기록할 수 없습니다."
                    : hasLessonToday
                      ? `오늘 수업 ${todaySlots.map((x) => `${x.start}–${x.end}`).join(", ")} · 등원한 원생만 출석·결석을 기록할 수 있습니다.`
                      : "오늘은 이 반 수업이 없어 출결을 기록할 수 없습니다."}
                </p>
              ) : null}
              {notice ? (
                <p
                  role="status"
                  className={`mb-2 break-keep rounded-xl px-3 py-2 text-xs ${
                    notice.ok ? "bg-emerald-500/10 text-emerald-900" : "bg-red-500/10 text-red-800"
                  }`}
                >
                  {notice.text}
                </p>
              ) : null}
              {watch && todayState.error ? (
                <p className="mb-2 break-keep text-[11px] text-red-700" role="alert">
                  {todayState.error}
                </p>
              ) : null}
              {studentsError ? (
                <p className="text-xs text-red-800">
                  {studentsError}{" "}
                  <button type="button" className="underline" onClick={onRetryStudentsAction}>
                    다시 시도
                  </button>
                </p>
              ) : !studentsReady ? (
                <p className="py-4 text-center text-xs text-neutral-400">불러오는 중…</p>
              ) : members.length === 0 ? (
                <p className="py-4 text-center text-xs text-neutral-500">배정된 원생이 없습니다.</p>
              ) : (
                <ul className="-mx-1 divide-y divide-neutral-200/70">
                  {members.map((s) => (
                    <li key={s.id} className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onOpenStudentAction(s.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1 py-2.5 text-left hover:bg-black/[0.03]"
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
                        {canMark ? null : (
                          <span aria-hidden className="ml-auto shrink-0 text-neutral-400">
                            ›
                          </span>
                        )}
                      </button>
                      {canMark ? (
                        <ClassAttendanceControls
                          studentActive={isActiveStudent(s)}
                          classEnded={ended}
                          hasLessonToday={hasLessonToday}
                          arrival={todayState.arrivals.get(s.id)}
                          record={todayState.records.get(s.id)}
                          stateError={
                            Boolean(todayState.error) ||
                            (isActiveStudent(s) && hasLessonToday && !ended && !canReadArrival(s))
                          }
                          allowArrive={false}
                          busy={rowBusyFor(busyKey, s.id, cls.id)}
                          disabled={busyKey !== null}
                          onAction={(action) => onAttendance(s, action)}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </main>
      </div>

      {confirmOpen ? (
        <div
          className="fixed inset-0 z-[170] flex items-end justify-center bg-black/40 sm:items-center"
          role="presentation"
          onClick={() => (deleting ? undefined : setConfirmOpen(false))}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="class-delete-title"
            className="w-full max-w-lg rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="class-delete-title" className="text-base font-semibold text-foreground">
              {cls.name} 반을 삭제할까요?
            </h2>
            <p className="mt-2 break-keep text-sm text-neutral-600">
              {studentsReady && members.length > 0
                ? `원생 ${members.length}명이 이 반에서 빠지고, 반 선생님의 담당 학생에서도 빠집니다.`
                : "반 선생님의 담당 학생에서 이 반이 빠집니다."}{" "}
              원생 정보는 그대로 남고, 변경 이력은 보관됩니다. 수업을 잠시 쉬는 것이라면 삭제 대신 종강으로 바꿔 주세요.
            </p>
            {deleteError ? (
              <p className="mt-2 break-keep text-sm text-red-700" role="alert">
                {deleteError}
              </p>
            ) : null}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setConfirmOpen(false)}
                className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium disabled:opacity-50"
              >
                취소
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => void onDelete()}
                className="flex-1 rounded-2xl bg-red-600 py-3 text-sm font-medium text-white disabled:opacity-50"
              >
                {deleting ? "삭제 중…" : "삭제"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </ModalPortal>
  );
}
