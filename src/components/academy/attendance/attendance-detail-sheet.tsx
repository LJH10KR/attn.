"use client";

import { useEffect, useState } from "react";
import {
  AttendanceCancelDialog,
  type AttendanceCancelTarget,
  type KnownClassRecord,
} from "@/components/academy/attendance/attendance-cancel-dialog";
import { ModalPortal } from "@/components/ui/modal-portal";
import { arrivalSummary, arrivalTimeInput } from "@/lib/academy/attendance-labels";
import {
  ABSENCE_REASONS,
  ABSENCE_REASON_LABELS,
  ATTENDANCE_NOTE_MAX_LENGTH,
  CLASS_ATTENDANCE_BLOCK_LABELS,
  classAttendanceBlock,
  dateLabel,
  type AbsenceReason,
  type AttendanceStatus,
} from "@/lib/academy/attendance-rules";
import type { DayArrival, DayClassRecord, RosterSlot } from "@/lib/academy/day-roster";
import { useAttendanceActions } from "@/lib/academy/use-attendance-actions";
import { useAttendanceCorrections, type CallOutcome } from "@/lib/academy/use-attendance-corrections";
import type { AttendanceCorrectionRow } from "@/lib/academy/use-day-attendance";

const segBtn = (selected: boolean, tone: "green" | "amber" | "gray") =>
  `flex-1 rounded-xl border px-2 py-2 text-xs font-medium transition disabled:cursor-not-allowed ${selected ? "cursor-default" : "disabled:opacity-40"} ${
    selected
      ? tone === "green"
        ? "border-emerald-600 bg-emerald-600 text-white"
        : tone === "amber"
          ? "border-amber-600 bg-amber-600 text-white"
          : "border-neutral-700 bg-neutral-700 text-white"
      : "border-neutral-300/80 bg-white text-neutral-800"
  }`;
const chip = (selected: boolean) =>
  `rounded-full border px-3 py-1 text-[11px] font-medium disabled:opacity-40 ${
    selected ? "border-[#222] bg-[#222] text-white" : "border-neutral-300/80 bg-white text-neutral-700"
  }`;
const sectionCls = "rounded-2xl border border-neutral-200/80 bg-white/60 px-3 py-3";
const saveBtn =
  "shrink-0 rounded-[8px] bg-[#222] px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-40";

export type DetailClassContext = {
  classId: string;
  className: string;
  slots: RosterSlot[];
  record: DayClassRecord | null;
  /** 오늘 조건(today 모드에서만 씀) */
  classEnded: boolean;
  hasLesson: boolean;
};

/**
 * 3-A 원장 출결 화면 — 한 원생 × 날짜 상세(등원 기록 + 그 반 출결 + 사유·메모·코멘트, A7·★8).
 * - 오늘: 상태는 기존 기록·취소 함수(알림 있음), 사유·메모는 `updateAttendanceDetails`(알림 없음)
 * - 지난 날짜: 정정 함수(알림 없음, 정정 이력)
 * 원장·출결 권한만 여는 화면이라 버튼 노출은 권한으로 다시 나누지 않는다(실제 차단은 서버).
 */
export function AttendanceDetailSheet({
  academyId,
  date,
  mode,
  student,
  arrival,
  classCtx,
  knownClassRecords,
  lastCorrection,
  onNoticeAction,
  onOpenStudentAction,
  onCloseAction,
}: {
  academyId: string;
  date: string;
  mode: "today" | "past";
  student: { id: string; name: string; active: boolean };
  arrival: DayArrival | null | undefined;
  classCtx: DetailClassContext | null;
  /** 그날 이 원생의 모든 반 출결(등원 → 미등원·지우기 미리 확인) */
  knownClassRecords: KnownClassRecord[];
  lastCorrection: AttendanceCorrectionRow | null;
  onNoticeAction: (text: string, ok: boolean) => void;
  onOpenStudentAction: () => void;
  onCloseAction: () => void;
}) {
  const past = mode === "past";
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<AttendanceCancelTarget | null>(null);
  const [time, setTime] = useState(arrivalTimeInput(arrival));
  const [note, setNote] = useState(arrival?.note ?? "");
  const [comment, setComment] = useState(classCtx?.record?.comment ?? "");

  // 다른 곳에서 기록이 바뀌면 입력칸을 새 값으로(편집 중이 아닐 때만 의미 있음 — 저장 뒤 같은 값)
  useEffect(() => setTime(arrivalTimeInput(arrival)), [arrival]);
  useEffect(() => setNote(arrival?.note ?? ""), [arrival?.note]);
  useEffect(() => setComment(classCtx?.record?.comment ?? ""), [classCtx?.record?.comment]);

  const show = (text: string, ok: boolean) => {
    setMessage({ text, ok });
    onNoticeAction(text, ok);
  };
  const actions = useAttendanceActions(academyId, (text, ok) => show(text, ok));
  const fixes = useAttendanceCorrections(academyId);
  const busy = actions.busyKey !== null || fixes.busyKey !== null;
  const done = (o: CallOutcome, okText: string) =>
    o.ok ? show(o.changed ? okText : "바뀐 내용이 없습니다.", true) : show(o.message, false);
  const who = student.name;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !cancelTarget && !busy) onCloseAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelTarget, busy, onCloseAction]);

  // ── 등원 기록 ──
  const setArrival = async (status: AttendanceStatus) => {
    setMessage(null);
    if (!past) {
      await actions.markArrival(student.id, status, "attendance_screen", date, who);
      return;
    }
    done(
      await fixes.correctArrival({ studentId: student.id, date, status, via: "attendance_screen" }),
      `${who} ${dateLabel(date)} 등원 기록을 ${status === "present" ? "등원" : "미등원"}으로 정정했습니다.`,
    );
  };
  const clearArrival = () => {
    if (!arrival) return;
    setCancelTarget({
      kind: "arrival",
      studentId: student.id,
      studentName: who,
      status: arrival.status,
      reason: arrival.reason,
      billed: arrival.billed,
      knownClassRecords,
      past,
    });
  };
  const saveTime = async () => {
    setMessage(null);
    done(
      await fixes.correctArrival({
        studentId: student.id,
        date,
        status: "present",
        arrivedAtTime: time || null,
        via: "attendance_screen",
      }),
      time ? `등원 시각을 ${time}로 정정했습니다.` : "등원 시각을 지웠습니다.",
    );
  };
  const saveArrivalDetails = async (p: { reason?: AbsenceReason; note?: string }) => {
    setMessage(null);
    done(
      await fixes.updateDetails({ layer: "arrival", studentId: student.id, date, ...p, via: "attendance_screen" }),
      p.reason ? `사유를 ${ABSENCE_REASON_LABELS[p.reason]}(으)로 바꿨습니다.` : "메모를 저장했습니다.",
    );
  };

  // ── 반 출결 ──
  const record = classCtx?.record ?? null;
  const classBlock = classCtx
    ? classAttendanceBlock({
        studentActive: past ? true : student.active,
        isMember: true,
        classEnded: past ? false : classCtx.classEnded,
        hasLessonToday: past ? true : classCtx.hasLesson,
        arrival: arrival === undefined ? { status: "present", billed: false } : arrival,
      })
    : null;
  const setClass = async (status: AttendanceStatus) => {
    if (!classCtx) return;
    setMessage(null);
    if (!past) {
      await actions.markClass(classCtx.classId, classCtx.className, student.id, status, "attendance_screen", date, who);
      return;
    }
    done(
      await fixes.correctClass({ classId: classCtx.classId, studentId: student.id, date, status, via: "attendance_screen" }),
      `${who} ${classCtx.className} 수업을 ${status === "present" ? "출석" : "결석"}으로 정정했습니다.`,
    );
  };
  const clearClass = () => {
    if (!classCtx || !record) return;
    setCancelTarget({
      kind: "class",
      studentId: student.id,
      studentName: who,
      classId: classCtx.classId,
      className: classCtx.className,
      status: record.status,
      past,
    });
  };
  const saveClassDetails = async (p: { reason?: AbsenceReason; note?: string }) => {
    if (!classCtx) return;
    setMessage(null);
    done(
      await fixes.updateDetails({
        layer: "class",
        classId: classCtx.classId,
        studentId: student.id,
        date,
        ...p,
        via: "attendance_screen",
      }),
      p.reason ? `수업 결석 사유를 ${ABSENCE_REASON_LABELS[p.reason]}(으)로 바꿨습니다.` : "코멘트를 저장했습니다.",
    );
  };

  const confirmCancel = async (): Promise<string | null> => {
    const t = cancelTarget;
    if (!t) return null;
    setMessage(null);
    if (!past) {
      return t.kind === "class"
        ? actions.cancelClass({
            classId: t.classId, className: t.className, studentId: t.studentId, status: t.status, date,
            via: "attendance_screen", studentName: who,
          })
        : actions.cancelArrival({ studentId: t.studentId, status: t.status, date, via: "attendance_screen", studentName: who });
    }
    const o =
      t.kind === "class"
        ? await fixes.correctClass({ classId: t.classId, studentId: t.studentId, date, status: null, via: "attendance_screen" })
        : await fixes.correctArrival({ studentId: t.studentId, date, status: null, via: "attendance_screen" });
    if (!o.ok) return o.message;
    show(t.kind === "class" ? `${t.className} 수업 출결 기록을 지웠습니다.` : "등원 기록을 지웠습니다.", true);
    return null;
  };

  const arrivalLoading = arrival === undefined;
  const absentReason = arrival?.status === "absent" ? arrival.reason ?? "general" : null;

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[200] flex items-end justify-center bg-black/40 sm:items-center"
        role="presentation"
        onClick={() => (busy ? undefined : onCloseAction())}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="attendance-detail-title"
          className="flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-3xl bg-[#f7f6f2] shadow-2xl sm:rounded-3xl"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="flex shrink-0 items-start justify-between gap-2 px-5 pb-2 pt-4">
            <div className="min-w-0">
              <h2 id="attendance-detail-title" className="truncate text-base font-semibold text-foreground">
                {who}
              </h2>
              <p className="text-xs text-neutral-500">
                {dateLabel(date)} {past ? "· 지난 날짜 정정" : "· 오늘"}
              </p>
            </div>
            <button
              type="button"
              onClick={onCloseAction}
              disabled={busy}
              className="rounded-full px-2 py-1 text-sm text-neutral-500 disabled:opacity-40"
              aria-label="닫기"
            >
              ✕
            </button>
          </header>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-[calc(max(1.25rem,env(safe-area-inset-bottom))+12px)]">
            <p className="break-keep text-[11px] text-neutral-500">
              {past
                ? "지난 날짜 정정은 학부모 알림이 가지 않고, 정정 기록이 남습니다."
                : "상태를 바꾸면 학부모에게 알림이 갑니다. 사유·메모·코멘트는 알림 없이 저장됩니다."}
            </p>
            {message ? (
              <p
                role="status"
                className={`break-keep rounded-xl px-3 py-2 text-xs ${
                  message.ok ? "bg-emerald-500/10 text-emerald-900" : "bg-red-500/10 text-red-800"
                }`}
              >
                {message.text}
              </p>
            ) : null}

            <section className={sectionCls} aria-label="등원 기록">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-foreground">등원 기록</h3>
                <span className="text-[11px] text-neutral-500">{arrivalSummary(arrival)}</span>
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  aria-pressed={arrival?.status === "present"}
                  disabled={busy || arrivalLoading}
                  onClick={() => arrival?.status !== "present" && void setArrival("present")}
                  className={segBtn(arrival?.status === "present", "green")}
                >
                  등원
                </button>
                <button
                  type="button"
                  aria-pressed={arrival?.status === "absent"}
                  disabled={busy || arrivalLoading}
                  onClick={() => arrival?.status !== "absent" && void setArrival("absent")}
                  className={segBtn(arrival?.status === "absent", "amber")}
                >
                  미등원
                </button>
                <button
                  type="button"
                  aria-pressed={arrival === null}
                  disabled={busy || arrivalLoading}
                  onClick={() => arrival && clearArrival()}
                  className={segBtn(arrival === null, "gray")}
                >
                  기록 없음
                </button>
              </div>
              {arrival?.billed ? (
                <p className="mt-2 break-keep text-[11px] text-sky-800">
                  청구서 결석 차감에 반영된 날이라 상태·사유는 바꿀 수 없습니다(메모는 저장 가능).
                </p>
              ) : null}

              {past && arrival?.status === "present" ? (
                <div className="mt-3 flex items-center gap-2">
                  <label htmlFor="arrived-at-time" className="shrink-0 text-[11px] text-neutral-600">
                    등원 시각
                  </label>
                  <input
                    id="arrived-at-time"
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    className="min-w-0 flex-1 rounded-xl border border-neutral-300/80 bg-white px-2 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    disabled={busy || time === arrivalTimeInput(arrival)}
                    onClick={() => void saveTime()}
                    className={saveBtn}
                  >
                    {time || !arrivalTimeInput(arrival) ? "시각 저장" : "시각 지우기"}
                  </button>
                </div>
              ) : null}

              {arrival?.status === "absent" ? (
                <div className="mt-3">
                  <p className="mb-1.5 text-[11px] text-neutral-600">미등원 사유</p>
                  <div className="flex flex-wrap gap-1.5">
                    {ABSENCE_REASONS.map((r) => (
                      <button
                        key={r}
                        type="button"
                        aria-pressed={absentReason === r}
                        disabled={busy || arrival.billed || absentReason === r}
                        onClick={() => void saveArrivalDetails({ reason: r })}
                        className={chip(absentReason === r)}
                      >
                        {ABSENCE_REASON_LABELS[r]}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {arrival ? (
                <NoteField
                  id="arrival-note"
                  label="메모"
                  value={note}
                  saved={arrival.note ?? ""}
                  busy={busy}
                  onChange={setNote}
                  onSave={() => void saveArrivalDetails({ note })}
                />
              ) : null}
            </section>

            {classCtx ? (
              <section className={sectionCls} aria-label={`${classCtx.className} 수업 출결`}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="min-w-0 truncate text-xs font-semibold text-foreground">
                    {classCtx.className} 수업
                  </h3>
                  <span className="shrink-0 text-[11px] text-neutral-500">
                    {classCtx.slots.length > 0
                      ? classCtx.slots.map((s) => `${s.start}–${s.end}`).join(", ")
                      : "수업 시간 기록 없음"}
                  </span>
                </div>
                <div className="flex gap-1.5">
                  {(["present", "absent"] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      aria-pressed={record?.status === st}
                      disabled={busy || (record?.status !== st && (Boolean(classBlock) || Boolean(record?.hasSessionDeduction)))}
                      onClick={() => record?.status !== st && void setClass(st)}
                      className={segBtn(record?.status === st, st === "present" ? "green" : "amber")}
                    >
                      {st === "present" ? "출석" : "결석"}
                    </button>
                  ))}
                  <button
                    type="button"
                    aria-pressed={!record}
                    disabled={busy || Boolean(record?.hasSessionDeduction)}
                    onClick={() => record && clearClass()}
                    className={segBtn(!record, "gray")}
                  >
                    미처리
                  </button>
                </div>
                {classBlock && !record ? (
                  <p className="mt-2 text-[11px] text-neutral-500">
                    {past && classBlock === "not_arrived" ? "등원 기록 없음" : CLASS_ATTENDANCE_BLOCK_LABELS[classBlock]} —
                    등원 기록을 먼저 {past ? "정정" : "처리"}해 주세요.
                  </p>
                ) : null}
                {record?.hasSessionDeduction ? (
                  <p className="mt-2 text-[11px] text-neutral-500">회차 차감이 연결된 기록이라 정정할 수 없습니다.</p>
                ) : null}
                {record?.status === "absent" ? (
                  <div className="mt-3">
                    <p className="mb-1.5 text-[11px] text-neutral-600">수업 결석 사유</p>
                    <div className="flex flex-wrap gap-1.5">
                      {ABSENCE_REASONS.map((r) => {
                        const cur = record.reason ?? "general";
                        return (
                          <button
                            key={r}
                            type="button"
                            aria-pressed={cur === r}
                            disabled={busy || cur === r || record.hasSessionDeduction}
                            onClick={() => void saveClassDetails({ reason: r })}
                            className={chip(cur === r)}
                          >
                            {ABSENCE_REASON_LABELS[r]}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                {record ? (
                  <NoteField
                    id="class-comment"
                    label="코멘트"
                    value={comment}
                    saved={record.comment ?? ""}
                    busy={busy}
                    onChange={setComment}
                    onSave={() => void saveClassDetails({ note: comment })}
                  />
                ) : null}
              </section>
            ) : null}

            {lastCorrection ? (
              <p className="break-keep text-[11px] text-neutral-500">
                마지막 정정 · {lastCorrection.byName || "알 수 없음"}{" "}
                {new Date(lastCorrection.atMs).toLocaleString("ko-KR", {
                  timeZone: "Asia/Seoul",
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  hourCycle: "h23",
                })}
              </p>
            ) : null}
            <button
              type="button"
              onClick={onOpenStudentAction}
              disabled={busy}
              className="w-full rounded-2xl border border-neutral-300/80 bg-white/70 py-2.5 text-sm font-medium text-foreground disabled:opacity-40"
            >
              학생 상세 열기
            </button>
          </div>
        </div>
      </div>

      {cancelTarget ? (
        <AttendanceCancelDialog
          target={cancelTarget}
          onConfirmAction={confirmCancel}
          onCloseAction={() => setCancelTarget(null)}
        />
      ) : null}
    </ModalPortal>
  );
}

function NoteField({
  id,
  label,
  value,
  saved,
  busy,
  onChange,
  onSave,
}: {
  id: string;
  label: string;
  value: string;
  saved: string;
  busy: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between">
        <label htmlFor={id} className="text-[11px] text-neutral-600">
          {label}
        </label>
        <span className="text-[10px] text-neutral-400">
          {value.length}/{ATTENDANCE_NOTE_MAX_LENGTH}
        </span>
      </div>
      <div className="flex items-end gap-2">
        <textarea
          id={id}
          rows={2}
          maxLength={ATTENDANCE_NOTE_MAX_LENGTH}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 flex-1 resize-none rounded-xl border border-neutral-300/80 bg-white px-2.5 py-1.5 text-sm"
          placeholder="알림 없이 저장됩니다"
        />
        <button type="button" disabled={busy || value.trim() === saved.trim()} onClick={onSave} className={saveBtn}>
          저장
        </button>
      </div>
    </div>
  );
}
