"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAcademyShell } from "@/components/academy/academy-shell";
import {
  AttendanceCancelDialog,
  type AttendanceCancelTarget,
  type KnownClassRecord,
} from "@/components/academy/attendance/attendance-cancel-dialog";
import { AttendanceCorrectionsList } from "@/components/academy/attendance/attendance-corrections-list";
import { AttendanceDetailSheet, type DetailClassContext } from "@/components/academy/attendance/attendance-detail-sheet";
import {
  ClassAttendanceControls,
  type ClassAttendanceAction,
} from "@/components/academy/attendance/class-attendance-controls";
import { StudentDetailSheet, STUDENT_STATUS_BADGE_CLASS } from "@/components/academy/student-detail/student-detail-sheet";
import { useStudentDetailParam } from "@/components/academy/student-detail/use-student-detail-param";
import { ModalPortal } from "@/components/ui/modal-portal";
import { arrivalSummary, reasonLabel } from "@/lib/academy/attendance-labels";
import { ATTENDANCE_BATCH_MAX, dateLabel, weekdayOfDate } from "@/lib/academy/attendance-rules";
import {
  buildDayRoster,
  ROSTER_FILTER_ALL,
  ROSTER_FILTER_NO_CLASS,
  rosterFilterOptions,
  summarizeDay,
  type DayArrival,
  type RosterRow,
  type RosterSection,
} from "@/lib/academy/day-roster";
import { STUDENT_STATUS_LABELS } from "@/lib/academy/student-profile";
import { useAcademyClasses } from "@/lib/academy/use-academy-classes";
import { rowBusyFor, useAttendanceActions } from "@/lib/academy/use-attendance-actions";
import {
  useAttendanceCorrections,
  type BatchAction,
  type BatchResult,
  type CallOutcome,
} from "@/lib/academy/use-attendance-corrections";
import { useSeoulToday } from "@/lib/academy/use-class-today-attendance";
import {
  useAcademyStudentList,
  useDayArrivals,
  useDayClassRecords,
  useDayCorrections,
} from "@/lib/academy/use-day-attendance";

const WEEKDAY_KO = ["", "월", "화", "수", "목", "금", "토", "일"];
const DAY_MS = 86_400_000;
const navBtn =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-neutral-300/70 bg-white/60 text-sm text-foreground disabled:opacity-30";

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00+09:00`) + days * DAY_MS).toLocaleDateString("en-CA", {
    timeZone: "Asia/Seoul",
  });
}

const LEFTOVER_LABEL = { ended: "종강", no_lesson: "이 요일 수업 없음", deleted: "삭제된 반" } as const;
const BATCH_LABEL: Record<BatchAction, string> = { arrive: "등원", class_present: "출석", class_absent: "결석" };

type DetailTarget = { studentId: string; classId: string | null };
type BatchConfirm = { section: RosterSection; action: BatchAction; studentIds: string[] };

/**
 * 수업 › 출결관리(3-A) — 날짜·반별 명단, 등원 + 반 출결, 지난 날짜 정정, 사유·코멘트, 일괄 처리, 그날 정정 기록.
 * 결정 `docs/stage3-handoff/3-A-start.md`, 계획 `3-A-plan.md` 2장. 접근 = `lessons.attendance`(셸이 막음).
 * - 오늘: 기존 기록·취소 함수(알림 있음), 지난 날짜: 정정 함수(알림 없음·정정 이력)
 * - 화면 날짜는 직접 고른 값 — 자정을 넘기면 같은 날짜가 "지난 날짜"로 바뀐다(서버도 B1로 확인)
 */
export function AcademyAttendanceScreen() {
  const { academyId, permissions, href } = useAcademyShell();
  const today = useSeoulToday();
  const [date, setDate] = useState(today.date);
  const mode: "today" | "past" = date === today.date ? "today" : "past";
  const past = mode === "past";
  const weekday = weekdayOfDate(date);
  const [filter, setFilter] = useState<string>(ROSTER_FILTER_ALL);
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [cancelTarget, setCancelTarget] = useState<AttendanceCancelTarget | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [batchConfirm, setBatchConfirm] = useState<BatchConfirm | null>(null);
  const [batchResult, setBatchResult] = useState<{ section: RosterSection; action: BatchAction; result: BatchResult } | null>(null);
  const [pastBusy, setPastBusy] = useState<string | null>(null);
  const studentDetail = useStudentDetailParam();

  const enabled = permissions.can("lessons.attendance");
  const classesState = useAcademyClasses(academyId, enabled);
  const students = useAcademyStudentList(academyId, enabled, retry);
  const arrivals = useDayArrivals(academyId, date, enabled, retry);
  const records = useDayClassRecords(academyId, date, enabled, retry);
  const corrections = useDayCorrections(academyId, date, enabled, retry);
  const loaded = !classesState.loading && students.loaded && arrivals.loaded && records.loaded;
  const loadError = classesState.error ?? students.error ?? arrivals.error ?? records.error;

  const roster = useMemo(
    () =>
      buildDayRoster({
        weekday,
        classes: classesState.classes,
        students: students.data,
        arrivals: arrivals.data,
        records: records.data,
      }),
    [weekday, classesState.classes, students.data, arrivals.data, records.data],
  );
  const filterOptions = useMemo(() => rosterFilterOptions(roster), [roster]);
  // 날짜를 바꿨는데 고른 반이 그날 목록에 없으면 전체로
  useEffect(() => {
    if (loaded && !filterOptions.some((o) => o.value === filter)) setFilter(ROSTER_FILTER_ALL);
  }, [loaded, filterOptions, filter]);
  const summary = useMemo(() => summarizeDay(roster, filter), [roster, filter]);
  const sections = roster.sections.filter(
    (s) => filter === ROSTER_FILTER_ALL || s.classId === filter,
  );
  const showNoClass = filter === ROSTER_FILTER_ALL || filter === ROSTER_FILTER_NO_CLASS;
  const studentById = useMemo(() => new Map(students.data.map((s) => [s.id, s])), [students.data]);

  const changeDate = (next: string) => {
    if (!next || next > today.date) return;
    setDate(next);
    setSelecting(null);
    setSelected(new Set());
    setNotice(null);
  };

  const onDone = useCallback((text: string, ok: boolean) => setNotice({ text, ok }), []);
  const actions = useAttendanceActions(academyId, onDone);
  const fixes = useAttendanceCorrections(academyId);
  const anyBusy = actions.busyKey !== null || fixes.busyKey !== null;

  const recordsOf = useCallback(
    (studentId: string): KnownClassRecord[] =>
      records.data.filter((r) => r.studentId === studentId).map((r) => ({ className: r.className, status: r.status })),
    [records.data],
  );

  const pastOutcome = (o: CallOutcome, okText: string) =>
    setNotice(o.ok ? { text: o.changed ? okText : "바뀐 내용이 없습니다.", ok: true } : { text: o.message, ok: false });

  const onRowAction = async (section: RosterSection, row: RosterRow, action: ClassAttendanceAction) => {
    if (action.kind === "cancel_class") {
      setCancelTarget({
        kind: "class", studentId: row.studentId, studentName: row.name, classId: section.classId,
        className: section.className, status: action.status, past,
      });
      return;
    }
    if (action.kind === "cancel_arrival") {
      setCancelTarget({
        kind: "arrival", studentId: row.studentId, studentName: row.name, status: action.arrival.status,
        reason: action.arrival.reason, billed: action.arrival.billed, knownClassRecords: recordsOf(row.studentId), past,
      });
      return;
    }
    setNotice(null);
    if (!past) {
      if (action.kind === "arrive") await actions.markArrival(row.studentId, "present", "attendance_screen", date, row.name);
      else await actions.markClass(section.classId, section.className, row.studentId, action.status, "attendance_screen", date, row.name);
      return;
    }
    if (action.kind === "arrive") {
      setPastBusy(`${row.studentId}:arrival:present`);
      pastOutcome(
        await fixes.correctArrival({ studentId: row.studentId, date, status: "present", via: "attendance_screen" }),
        `${row.name} ${dateLabel(date)} 등원으로 정정했습니다.`,
      );
    } else {
      setPastBusy(`${row.studentId}:${section.classId}:${action.status}`);
      pastOutcome(
        await fixes.correctClass({
          classId: section.classId, studentId: row.studentId, date, status: action.status, via: "attendance_screen",
        }),
        `${row.name} ${section.className} ${action.status === "present" ? "출석" : "결석"}으로 정정했습니다.`,
      );
    }
    setPastBusy(null);
  };

  const confirmCancel = async (): Promise<string | null> => {
    const t = cancelTarget;
    if (!t) return null;
    setNotice(null);
    if (!past) {
      return t.kind === "class"
        ? actions.cancelClass({
            classId: t.classId, className: t.className, studentId: t.studentId, status: t.status, date,
            via: "attendance_screen", studentName: t.studentName,
          })
        : actions.cancelArrival({ studentId: t.studentId, status: t.status, date, via: "attendance_screen", studentName: t.studentName });
    }
    const o =
      t.kind === "class"
        ? await fixes.correctClass({ classId: t.classId, studentId: t.studentId, date, status: null, via: "attendance_screen" })
        : await fixes.correctArrival({ studentId: t.studentId, date, status: null, via: "attendance_screen" });
    if (!o.ok) return o.message;
    setNotice({
      text: t.kind === "class" ? `${t.studentName} ${t.className} 수업 출결 기록을 지웠습니다.` : `${t.studentName} 등원 기록을 지웠습니다.`,
      ok: true,
    });
    return null;
  };

  const runBatch = async () => {
    const c = batchConfirm;
    if (!c) return;
    const result = await fixes.runBatch({ date, mode, classId: c.section.classId, action: c.action, studentIds: c.studentIds });
    setBatchConfirm(null);
    setBatchResult({ section: c.section, action: c.action, result });
    if (result.ok) {
      setSelecting(null);
      setSelected(new Set());
    }
  };

  // 상세 시트 대상
  const detailRow = useMemo(() => {
    if (!detail) return null;
    const section = detail.classId ? roster.sections.find((s) => s.classId === detail.classId) ?? null : null;
    const row = section?.rows.find((r) => r.studentId === detail.studentId) ?? null;
    const s = studentById.get(detail.studentId);
    const arrival: DayArrival | null | undefined = arrivals.loaded ? arrivals.data.get(detail.studentId) ?? null : undefined;
    const classCtx: DetailClassContext | null = section
      ? {
          classId: section.classId,
          className: section.className,
          slots: row?.record?.slots.length ? row.record.slots : section.slots,
          record: row?.record ?? null,
          classEnded: section.cls === null || section.cls.status === "ended",
          hasLesson: section.kind === "lesson",
        }
      : null;
    return {
      student: { id: detail.studentId, name: s?.name || row?.name || "학생", active: s?.status === "enrolled" },
      arrival,
      classCtx,
    };
  }, [detail, roster, studentById, arrivals.loaded, arrivals.data]);

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < ATTENDANCE_BATCH_MAX) next.add(id);
      return next;
    });
  const selectingSection = selecting ? roster.sections.find((s) => s.classId === selecting) ?? null : null;

  const [y, m, d] = date.split("-").map(Number);
  return (
    <div className="space-y-3 pb-8">
      {/* 날짜 막대 */}
      <div className="flex items-center gap-2">
        <button type="button" className={navBtn} aria-label="전날" onClick={() => changeDate(shiftDate(date, -1))}>
          ◀
        </button>
        <label className="relative min-w-0 flex-1 cursor-pointer text-center">
          <span className="block truncate text-base font-semibold text-foreground">
            {m}월 {d}일 ({WEEKDAY_KO[weekday]})
            {past ? null : <span className="ml-1.5 text-xs font-medium text-emerald-700">오늘</span>}
          </span>
          <span className="block text-[11px] text-neutral-500">{y}년 · 눌러서 날짜 고르기</span>
          <input
            type="date"
            value={date}
            max={today.date}
            onChange={(e) => changeDate(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label="날짜 고르기"
          />
        </label>
        <button
          type="button"
          className={navBtn}
          aria-label="다음 날"
          disabled={!past}
          onClick={() => changeDate(shiftDate(date, 1))}
        >
          ▶
        </button>
      </div>

      <div className="flex items-center gap-2">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className={`min-w-0 flex-1 rounded-full border bg-white/60 px-3 py-1.5 text-xs font-medium ${
            filter !== ROSTER_FILTER_ALL ? "border-[#222] text-foreground" : "border-neutral-300/70 text-neutral-700"
          }`}
          aria-label="반 선택"
        >
          {filterOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {past ? (
          <button
            type="button"
            onClick={() => changeDate(today.date)}
            className="shrink-0 rounded-full bg-[#222] px-3 py-1.5 text-xs font-medium text-white"
          >
            오늘로
          </button>
        ) : null}
      </div>

      {/* 요약 — 3-B 하원·지각 칸이 들어갈 자리(격자 확장) */}
      <section className="glass-card grid grid-cols-3 gap-y-2 px-4 py-3 text-center" aria-label="요약">
        <Stat label="등원" value={summary.present} tone="text-emerald-800" />
        <Stat label="미등원" value={summary.absent} tone="text-amber-800" />
        <Stat label="기록 없음" value={summary.noRecord} tone="text-neutral-600" />
        <Stat label="수업 출석" value={summary.classPresent} tone="text-emerald-800" />
        <Stat label="수업 결석" value={summary.classAbsent} tone="text-amber-800" />
        <Stat label="미처리" value={summary.unprocessed} tone="text-red-700" />
      </section>

      {past ? (
        <p className="break-keep rounded-2xl bg-sky-500/10 px-3 py-2 text-[11px] text-sky-900 ring-1 ring-sky-500/15">
          지난 날짜예요. 명단은 지금 시간표로 만들고(시간표 이력은 보관하지 않음), 정정해도 학부모 알림은 가지 않으며
          정정 기록이 남습니다.
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className={`sticky top-2 z-10 break-keep rounded-2xl px-3 py-2 text-center text-xs shadow-sm ring-1 ${
            notice.ok ? "bg-[#eef7f1] text-emerald-900 ring-emerald-500/20" : "bg-[#fbeeee] text-red-800 ring-red-500/15"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      {loadError ? (
        <div className="glass-card px-4 py-6 text-center">
          <p className="break-keep text-sm text-red-700">{loadError}</p>
          <button
            type="button"
            onClick={() => setRetry((n) => n + 1)}
            className="mt-3 rounded-full border border-neutral-300 px-4 py-1.5 text-xs font-medium"
          >
            다시 시도
          </button>
        </div>
      ) : !loaded ? (
        <p className="glass-card py-10 text-center text-sm text-neutral-400">불러오는 중…</p>
      ) : classesState.classes.length === 0 && roster.sections.length === 0 && roster.noClass.length === 0 ? (
        <div className="glass-card px-4 py-10 text-center">
          <p className="text-sm text-neutral-600">반을 먼저 만들어 주세요.</p>
          <a href={href("operations/classes")} className="mt-2 inline-block text-xs font-medium text-[#2f6fb5] underline">
            반 관리로 가기
          </a>
        </div>
      ) : sections.length === 0 && (!showNoClass || roster.noClass.length === 0) ? (
        <p className="glass-card px-4 py-10 text-center text-sm text-neutral-500 break-keep">
          이 날은 수업이 있는 반과 출결 기록이 없습니다.
        </p>
      ) : (
        <>
          {sections.map((section) => (
            <RosterSectionView
              key={section.classId}
              section={section}
              mode={mode}
              selecting={selecting === section.classId}
              selected={selected}
              busyKey={actions.busyKey ?? pastBusy}
              disabled={anyBusy}
              onToggleSelectMode={() => {
                setSelecting((cur) => (cur === section.classId ? null : section.classId));
                setSelected(new Set());
              }}
              onToggleRow={toggleSelect}
              onOpenRow={(row) => setDetail({ studentId: row.studentId, classId: section.classId })}
              onAction={(row, action) => void onRowAction(section, row, action)}
            />
          ))}
          {showNoClass && roster.noClass.length > 0 ? (
            <section aria-label="수업 반 없는 등원 원생">
              <h3 className="mb-2 px-1 text-sm font-semibold text-foreground">
                수업 반 없는 원생 <span className="text-xs font-normal text-neutral-500">{roster.noClass.length}명</span>
              </h3>
              <ul className="glass-card divide-y divide-neutral-200/70">
                {roster.noClass.map((n) => (
                  <li key={n.studentId}>
                    <button
                      type="button"
                      onClick={() => setDetail({ studentId: n.studentId, classId: null })}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
                    >
                      <span className="min-w-0 truncate text-sm font-medium text-foreground">{n.name}</span>
                      <span className="shrink-0 text-[11px] text-neutral-500">{n.gradeLabel}</span>
                      <span className="ml-auto shrink-0 text-[11px] text-neutral-600">{arrivalSummary(n.arrival)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      {corrections.data.length > 0 ? <AttendanceCorrectionsList rows={corrections.data} /> : null}

      {selectingSection ? (
        <ModalPortal>
          <div className="fixed inset-x-0 bottom-0 z-[120] border-t border-neutral-200 bg-white/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_24px_rgba(0,0,0,0.08)]">
            <div className="mx-auto flex max-w-lg items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-neutral-700">
                <b className="text-foreground">{selected.size}명</b> 선택 · {selectingSection.className}
              </span>
              {(["arrive", "class_present", "class_absent"] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  disabled={selected.size === 0 || anyBusy}
                  onClick={() => setBatchConfirm({ section: selectingSection, action: a, studentIds: [...selected] })}
                  className="shrink-0 rounded-[8px] bg-[#222] px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
                >
                  {BATCH_LABEL[a]}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setSelecting(null);
                  setSelected(new Set());
                }}
                className="shrink-0 rounded-[8px] border border-neutral-300 px-2.5 py-2 text-xs"
              >
                닫기
              </button>
            </div>
          </div>
        </ModalPortal>
      ) : null}

      {batchConfirm ? (
        <ConfirmSheet
          title={`${batchConfirm.studentIds.length}명을 ${batchConfirm.section.className} ${BATCH_LABEL[batchConfirm.action]}으로 처리할까요?`}
          body={
            past
              ? `${dateLabel(date)} 지난 날짜 정정이에요. 학부모 알림은 가지 않고 정정 기록이 남습니다. 처리할 수 없는 원생은 건너뜁니다.`
              : "오늘 기록이에요. 원생마다 학부모에게 알림이 갑니다(하루 10회 제한 그대로). 처리할 수 없는 원생은 건너뜁니다."
          }
          confirmLabel={`${BATCH_LABEL[batchConfirm.action]} 처리`}
          busy={fixes.busyKey === "batch"}
          onConfirm={() => void runBatch()}
          onClose={() => setBatchConfirm(null)}
        />
      ) : null}

      {batchResult ? (
        <BatchResultSheet
          title={`${batchResult.section.className} ${BATCH_LABEL[batchResult.action]} 일괄 처리`}
          result={batchResult.result}
          nameOf={(id) => studentById.get(id)?.name ?? "(알 수 없는 원생)"}
          onClose={() => setBatchResult(null)}
        />
      ) : null}

      {detail && detailRow ? (
        <AttendanceDetailSheet
          key={`${detail.studentId}:${detail.classId ?? ""}:${date}`}
          academyId={academyId}
          date={date}
          mode={mode}
          student={detailRow.student}
          arrival={detailRow.arrival}
          classCtx={detailRow.classCtx}
          knownClassRecords={recordsOf(detail.studentId)}
          lastCorrection={corrections.data.find((c) => c.studentId === detail.studentId) ?? null}
          onNoticeAction={onDone}
          onOpenStudentAction={() => {
            const id = detail.studentId;
            setDetail(null);
            studentDetail.open(id);
          }}
          onCloseAction={() => setDetail(null)}
        />
      ) : null}

      {cancelTarget ? (
        <AttendanceCancelDialog
          target={cancelTarget}
          onConfirmAction={confirmCancel}
          onCloseAction={() => setCancelTarget(null)}
        />
      ) : null}

      {studentDetail.studentId ? (
        <StudentDetailSheet
          key={studentDetail.studentId}
          academyId={academyId}
          studentId={studentDetail.studentId}
          tabParam={studentDetail.tabParam}
          permissions={permissions}
          onTabChangeAction={studentDetail.setTab}
          onCloseAction={studentDetail.close}
          onChangedAction={(message) => setNotice({ text: message, ok: true })}
        />
      ) : null}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div>
      <p className={`text-lg font-semibold leading-tight ${tone}`}>{value}</p>
      <p className="text-[10px] text-neutral-500">{label}</p>
    </div>
  );
}

function RosterSectionView({
  section,
  mode,
  selecting,
  selected,
  busyKey,
  disabled,
  onToggleSelectMode,
  onToggleRow,
  onOpenRow,
  onAction,
}: {
  section: RosterSection;
  mode: "today" | "past";
  selecting: boolean;
  selected: ReadonlySet<string>;
  busyKey: string | null;
  disabled: boolean;
  onToggleSelectMode: () => void;
  onToggleRow: (studentId: string) => void;
  onOpenRow: (row: RosterRow) => void;
  onAction: (row: RosterRow, action: ClassAttendanceAction) => void;
}) {
  const classEnded = section.cls === null || section.cls.status === "ended";
  const hasLesson = section.kind === "lesson";
  return (
    <section aria-label={section.className}>
      <div className="mb-2 flex items-center gap-1.5 px-1">
        <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">{section.className}</h3>
        <span className="shrink-0 text-[11px] text-neutral-500">
          {section.slots.length > 0 ? section.slots.map((s) => `${s.start}–${s.end}`).join(", ") : "수업 시간 기록 없음"}
        </span>
        {section.leftoverReason ? (
          <span className="shrink-0 rounded-full bg-neutral-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-700">
            기록만 · {LEFTOVER_LABEL[section.leftoverReason]}
          </span>
        ) : null}
        {/* 3-B 휴강 배지 자리 */}
        <span className="ml-auto shrink-0 text-[11px] text-neutral-500">{section.rows.length}명</span>
        {section.rows.length > 0 ? (
          <button
            type="button"
            onClick={onToggleSelectMode}
            aria-pressed={selecting}
            className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
              selecting ? "border-[#222] bg-[#222] text-white" : "border-neutral-300/70 bg-white/60 text-neutral-700"
            }`}
          >
            {selecting ? "선택 중" : "선택"}
          </button>
        ) : null}
      </div>
      {section.rows.length === 0 ? (
        <p className="glass-card py-6 text-center text-xs text-neutral-500">이 반 재원생이 없습니다.</p>
      ) : (
        <ul className="glass-card divide-y divide-neutral-200/70">
          {section.rows.map((row) => (
            <li key={row.studentId} className="flex items-center gap-2 px-3 py-2.5">
              {selecting ? (
                <input
                  type="checkbox"
                  checked={selected.has(row.studentId)}
                  onChange={() => onToggleRow(row.studentId)}
                  className="h-4 w-4 shrink-0 accent-[#222]"
                  aria-label={`${row.name} 선택`}
                />
              ) : null}
              <button type="button" onClick={() => onOpenRow(row)} className="min-w-0 flex-1 text-left">
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">{row.name}</span>
                  {row.gradeLabel ? <span className="shrink-0 text-[11px] text-neutral-500">{row.gradeLabel}</span> : null}
                  {row.studentStatus && row.studentStatus !== "enrolled" ? (
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${STUDENT_STATUS_BADGE_CLASS[row.studentStatus]}`}
                    >
                      {STUDENT_STATUS_LABELS[row.studentStatus]}
                    </span>
                  ) : null}
                </span>
                <RowChips row={row} />
              </button>
              <ClassAttendanceControls
                mode={mode}
                studentActive={row.studentStatus === "enrolled"}
                classEnded={classEnded}
                hasLessonToday={hasLesson}
                arrival={
                  row.arrival
                    ? { status: row.arrival.status, billed: row.arrival.billed, arrivedAtMs: row.arrival.arrivedAtMs, reason: row.arrival.reason }
                    : null
                }
                record={row.record?.status}
                stateError={false}
                allowArrive
                busy={rowBusyFor(busyKey, row.studentId, section.classId)}
                disabled={disabled}
                onAction={(action) => onAction(row, action)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 이름 아래 둘째 줄 — 3-B 지각·하원, 3-C 회차 칩이 들어갈 자리 */
function RowChips({ row }: { row: RosterRow }) {
  const chips: { text: string; cls: string }[] = [];
  if (row.arrival?.status === "present" && row.arrival.arrivedAtMs === null) {
    chips.push({ text: arrivalSummary(row.arrival), cls: "text-neutral-500" });
  }
  if (row.arrival?.status === "absent" && reasonLabel(row.arrival.reason) && row.arrival.reason !== "general") {
    chips.push({ text: `미등원 사유 ${reasonLabel(row.arrival.reason)}`, cls: "text-amber-800" });
  }
  if (!row.record && row.arrival?.status === "present") chips.push({ text: "미처리", cls: "text-red-700 font-semibold" });
  if (row.record?.status === "absent" && row.record.reason && row.record.reason !== "general") {
    chips.push({ text: `결석 사유 ${reasonLabel(row.record.reason)}`, cls: "text-amber-800" });
  }
  if (row.arrival?.note) chips.push({ text: `메모 ${row.arrival.note}`, cls: "text-neutral-600" });
  if (row.record?.comment) chips.push({ text: `💬 ${row.record.comment}`, cls: "text-neutral-600" });
  if (row.arrival?.corrected || row.record?.corrected) chips.push({ text: "정정됨", cls: "text-sky-800" });
  if (chips.length === 0) return null;
  return (
    <span className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 text-[10px]">
      {chips.map((c) => (
        <span key={c.text} className={`max-w-full truncate ${c.cls}`}>
          {c.text}
        </span>
      ))}
    </span>
  );
}

function ConfirmSheet({
  title,
  body,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[260] flex items-end justify-center bg-black/40 sm:items-center"
        role="presentation"
        onClick={() => (busy ? undefined : onClose())}
      >
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="attendance-batch-title"
          className="w-full max-w-lg rounded-t-3xl bg-white p-5 pb-[calc(max(1.25rem,env(safe-area-inset-bottom))+30px)] shadow-2xl sm:rounded-3xl sm:pb-5"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 id="attendance-batch-title" className="break-keep text-base font-semibold text-foreground">
            {title}
          </h2>
          <p className="mt-2 break-keep text-sm text-neutral-600">{body}</p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium disabled:opacity-50"
            >
              닫기
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onConfirm}
              className="flex-1 rounded-2xl bg-[#222] py-3 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "처리하는 중…" : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

function BatchResultSheet({
  title,
  result,
  nameOf,
  onClose,
}: {
  title: string;
  result: BatchResult;
  nameOf: (id: string) => string;
  onClose: () => void;
}) {
  const blocked = result.ok ? result.results.filter((r) => r.result === "blocked") : [];
  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[260] flex items-end justify-center bg-black/40 sm:items-center"
        role="presentation"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="attendance-batch-result-title"
          className="flex max-h-[80dvh] w-full max-w-lg flex-col rounded-t-3xl bg-white p-5 pb-[calc(max(1.25rem,env(safe-area-inset-bottom))+30px)] shadow-2xl sm:rounded-3xl sm:pb-5"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 id="attendance-batch-result-title" className="text-base font-semibold text-foreground">
            {title}
          </h2>
          {result.ok ? (
            <>
              <p className="mt-2 text-sm text-neutral-700">
                처리 {result.counts.changed}명 · 그대로 {result.counts.unchanged}명 · 건너뜀 {result.counts.blocked}명
                {result.mode === "past" ? " (알림 없음)" : ""}
              </p>
              {blocked.length > 0 ? (
                <ul className="mt-3 min-h-0 flex-1 space-y-1.5 overflow-y-auto">
                  {blocked.map((r) => (
                    <li key={r.studentId} className="rounded-xl bg-neutral-100 px-3 py-2 text-xs">
                      <b className="text-foreground">{nameOf(r.studentId)}</b>
                      <span className="mt-0.5 block break-keep text-neutral-600">{r.message}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className="mt-2 break-keep text-sm text-red-700" role="alert">
              {result.message}
            </p>
          )}
          <button
            type="button"
            onClick={onClose}
            className="mt-4 w-full rounded-2xl border border-neutral-200 py-3 text-sm font-medium"
          >
            닫기
          </button>
        </div>
      </div>
    </ModalPortal>
  );
}
