"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { KnownClassRecord } from "@/components/academy/attendance/attendance-cancel-dialog";
import {
  ClassAttendanceControls,
  type ClassAttendanceAction,
} from "@/components/academy/attendance/class-attendance-controls";
import type { AttendanceStatus } from "@/lib/academy/attendance-rules";
import { STUDENT_STATUS_BADGE_CLASS } from "@/components/academy/student-detail/student-detail-sheet";
import { scheduleSummary, slotsOnWeekday } from "@/lib/academy/class-schedule";
import { STUDENT_STATUS_LABELS, isActiveStudent } from "@/lib/academy/student-profile";
import { compareStudentsByName, type StudentVM } from "@/lib/academy/student-row";
import { compareClassesByOrder, type AcademyClassBrief } from "@/lib/academy/use-academy-classes";
import { rowBusyFor } from "@/lib/academy/use-attendance-actions";
import { useClassTodayAttendance } from "@/lib/academy/use-class-today-attendance";

const glassCard = "glass-card";

type ClassGroup = {
  key: string;
  cls: AcademyClassBrief | null;
  todayLabel: string | null;
  students: StudentVM[];
};

/**
 * 내 반 묶음 — 종강 반은 빼고(D5: 종강 반은 담당 계산에서 빠짐), 오늘(서울 요일) 수업이 있는 반을 먼저
 * 오늘 시작 시각 순으로, 나머지는 반 목록 순서대로. 내 반 어디에도 없는 담당 학생(트리거 지연 등)은 따로 모은다.
 */
export function groupMyClasses(
  classes: readonly AcademyClassBrief[],
  students: readonly StudentVM[],
  todayWeekday: number,
): ClassGroup[] {
  const open = classes.filter((c) => c.status !== "ended");
  const withToday = open.map((c) => ({ c, today: slotsOnWeekday(c.schedule, todayWeekday) }));
  withToday.sort((a, b) => {
    if (a.today.length > 0 !== b.today.length > 0) return a.today.length > 0 ? -1 : 1;
    if (a.today.length > 0) {
      const t = a.today[0]!.start.localeCompare(b.today[0]!.start);
      if (t !== 0) return t;
    }
    return compareClassesByOrder(a.c, b.c);
  });
  const openIds = new Set(open.map((c) => c.id));
  const groups: ClassGroup[] = withToday.map(({ c, today }) => ({
    key: c.id,
    cls: c,
    todayLabel: today.length > 0 ? today.map((s) => `${s.start}–${s.end}`).join(", ") : null,
    students: students.filter((s) => s.classIds.includes(c.id)).sort(compareStudentsByName),
  }));
  const others = students.filter((s) => !s.classIds.some((id) => openIds.has(id))).sort(compareStudentsByName);
  if (others.length > 0) groups.push({ key: "__others", cls: null, todayLabel: null, students: others });
  return groups;
}

type ClassRecordsReport = { className: string; records: ReadonlyMap<string, AttendanceStatus> };

/**
 * 선생님 화면 "내 반" — 반별 학생, 학생을 누르면 학생 상세 시트(정보 탭). 오늘 수업 반은 출석·결석(등원 전·미등원은 "등원 처리").
 * 2-J: 등원 취소(`cancel_arrival`)를 넘길 때 화면이 구독 중인 **그 학생의 모든 반** 출결을 함께 넘긴다
 * (구독하지 않는 반의 기록은 서버가 거부 문구로 안내).
 */
export function TeacherMyClasses({
  academyId,
  groups,
  today,
  roomLabelOf,
  canReadArrival,
  busyKey,
  onAttendanceAction,
  onOpenStudentAction,
}: {
  academyId: string;
  groups: ClassGroup[];
  today: { date: string; weekday: number };
  roomLabelOf: (roomId: string) => string | null;
  /** 등원 기록을 읽을 수 있는 학생(출결·청구서 권한 또는 학생 teacherUids에 본인) — 규칙과 같게 */
  canReadArrival: (s: StudentVM) => boolean;
  /** `useAttendanceActions().busyKey` */
  busyKey: string | null;
  onAttendanceAction: (
    student: StudentVM,
    cls: AcademyClassBrief,
    action: ClassAttendanceAction,
    knownClassRecords: KnownClassRecord[],
  ) => void;
  onOpenStudentAction: (studentId: string) => void;
}) {
  const [recordsByClass, setRecordsByClass] = useState<ReadonlyMap<string, ClassRecordsReport>>(() => new Map());
  const reportRecords = useCallback((classId: string, report: ClassRecordsReport | null) => {
    setRecordsByClass((prev) => {
      if (!report && !prev.has(classId)) return prev;
      const next = new Map(prev);
      if (report) next.set(classId, report);
      else next.delete(classId);
      return next;
    });
  }, []);
  const onAction = useCallback(
    (student: StudentVM, cls: AcademyClassBrief, action: ClassAttendanceAction) => {
      const known: KnownClassRecord[] =
        action.kind === "cancel_arrival"
          ? [...recordsByClass.values()].flatMap((r) => {
              const status = r.records.get(student.id);
              return status ? [{ className: r.className, status }] : [];
            })
          : [];
      onAttendanceAction(student, cls, action, known);
    },
    [recordsByClass, onAttendanceAction],
  );
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <TeacherClassSection
          key={g.key}
          academyId={academyId}
          group={g}
          today={today}
          roomLabelOf={roomLabelOf}
          canReadArrival={canReadArrival}
          busyKey={busyKey}
          onAttendanceAction={onAction}
          onRecordsChange={reportRecords}
          onOpenStudentAction={onOpenStudentAction}
        />
      ))}
    </div>
  );
}

function TeacherClassSection({
  academyId,
  group: g,
  today,
  roomLabelOf,
  canReadArrival,
  busyKey,
  onAttendanceAction,
  onRecordsChange,
  onOpenStudentAction,
}: {
  academyId: string;
  group: ClassGroup;
  today: { date: string; weekday: number };
  roomLabelOf: (roomId: string) => string | null;
  canReadArrival: (s: StudentVM) => boolean;
  busyKey: string | null;
  onAttendanceAction: (student: StudentVM, cls: AcademyClassBrief, action: ClassAttendanceAction) => void;
  onRecordsChange: (classId: string, report: ClassRecordsReport | null) => void;
  onOpenStudentAction: (studentId: string) => void;
}) {
  const c = g.cls;
  const room = c?.roomId ? roomLabelOf(c.roomId) : null;
  const schedule = c ? scheduleSummary(c.schedule) : "";
  const hasLessonToday = Boolean(c && g.todayLabel);
  // 오늘 수업이 있는 반만 구독(내 반이므로 반 출결 읽기 가능, 등원 기록은 규칙상 읽을 수 있는 학생만)
  const watch = Boolean(c && hasLessonToday && c.status !== "ended");
  const arrivalIds = useMemo(
    () => (watch ? g.students.filter((s) => isActiveStudent(s) && canReadArrival(s)).map((s) => s.id) : []),
    [watch, g.students, canReadArrival],
  );
  const state = useClassTodayAttendance({
    academyId,
    classId: c?.id ?? "__none",
    date: today.date,
    enabled: watch,
    arrivalStudentIds: arrivalIds,
  });
  // 구독 중인 반의 오늘 출결을 위로 알림(등원 취소 미리 확인용)
  const classId = c?.id ?? null;
  const className = c?.name ?? "";
  useEffect(() => {
    if (!classId) return;
    onRecordsChange(classId, watch && state.recordsLoaded ? { className, records: state.records } : null);
  }, [classId, className, watch, state.records, state.recordsLoaded, onRecordsChange]);
  useEffect(() => {
    if (!classId) return;
    return () => onRecordsChange(classId, null);
  }, [classId, onRecordsChange]);

  return (
    <section aria-label={c ? c.name : "그 밖의 담당 학생"}>
      <div className="mb-2 px-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 className="text-sm font-semibold text-foreground">{c ? c.name : "그 밖의 담당 학생"}</h3>
          {g.todayLabel ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-900">
              오늘 {g.todayLabel}
            </span>
          ) : null}
          {c?.status === "preparing" ? (
            <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-900">
              준비중
            </span>
          ) : null}
          <span className="ml-auto text-[11px] text-neutral-500">{g.students.length}명</span>
        </div>
        {c ? (
          <p className="mt-0.5 truncate text-[11px] text-neutral-500">
            {[schedule || "수업 시간 미정", room, c.teacherUids.length > 1 ? `선생님 ${c.teacherUids.length}명` : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : (
          <p className="mt-0.5 break-keep text-[11px] text-neutral-500">
            반 정보가 아직 반영되지 않았습니다. 잠시 후 목록을 새로고침해 주세요.
          </p>
        )}
        {watch && state.error ? (
          <p className="mt-1 break-keep text-[11px] text-red-700" role="alert">
            {state.error}
          </p>
        ) : null}
      </div>
      {g.students.length === 0 ? (
        <p className={`py-6 text-center text-xs text-neutral-500 ${glassCard}`}>배정된 학생이 없습니다.</p>
      ) : (
        <ul className={`divide-y divide-neutral-200/70 ${glassCard}`}>
          {g.students.map((s) => {
            const active = isActiveStudent(s);
            return (
              <li key={s.id} className="flex items-center gap-2 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => onOpenStudentAction(s.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">
                    {s.name || "(이름 없음)"}
                  </span>
                  <span className="shrink-0 text-[11px] text-neutral-500">{s.gradeLabel || "학년 미입력"}</span>
                  {!active ? (
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${STUDENT_STATUS_BADGE_CLASS[s.status]}`}
                    >
                      {STUDENT_STATUS_LABELS[s.status]}
                    </span>
                  ) : null}
                </button>
                {/* "그 밖의 담당 학생"은 수업 버튼을 숨긴다 */}
                {c ? (
                  <ClassAttendanceControls
                    studentActive={active}
                    classEnded={c.status === "ended"}
                    hasLessonToday={hasLessonToday}
                    arrival={state.arrivals.get(s.id)}
                    record={state.records.get(s.id)}
                    stateError={Boolean(state.error) || (active && hasLessonToday && !canReadArrival(s))}
                    allowArrive
                    busy={rowBusyFor(busyKey, s.id, c.id)}
                    disabled={busyKey !== null}
                    onAction={(action) => onAttendanceAction(s, c, action)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
