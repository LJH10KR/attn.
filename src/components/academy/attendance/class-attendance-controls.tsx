"use client";

import type { ReactNode } from "react";
import {
  classAttendanceBlock,
  CLASS_ATTENDANCE_BLOCK_LABELS,
  CLASS_STATUS_LABELS,
  formatSeoulHHmm,
  type ClassStatus,
} from "@/lib/academy/attendance-rules";
import type { RowBusy } from "@/lib/academy/use-attendance-actions";
import type { TodayArrival } from "@/lib/academy/use-class-today-attendance";

const baseBtn = "rounded-[8px] border px-2 py-1.5 text-[11px] font-medium transition disabled:cursor-not-allowed";
const toneBtn = (selected: boolean, on: string, off: string) => `${baseBtn} ${selected ? on : off}`;
const STATUS_STYLE: Record<ClassStatus, (selected: boolean) => string> = {
  present: (s) =>
    toneBtn(s, "border-emerald-600 bg-emerald-600 text-white", "border-emerald-400/60 bg-emerald-500/15 text-emerald-950 hover:bg-emerald-500/25"),
  late: (s) =>
    toneBtn(s, "border-violet-600 bg-violet-600 text-white", "border-violet-400/60 bg-violet-500/12 text-violet-950 hover:bg-violet-500/22"),
  absent: (s) =>
    toneBtn(s, "border-amber-600 bg-amber-600 text-white", "border-amber-400/60 bg-amber-500/12 text-amber-950 hover:bg-amber-500/22"),
};
const fadedBtn = `${baseBtn} border-neutral-300/60 bg-neutral-100/60 text-neutral-400`;

export type ClassAttendanceAction =
  | { kind: "class"; status: "present" | "absent" }
  | { kind: "arrive" }
  /**
   * 3-B 지각 창 — 지각이 아니면 기록, 이미 지각이면 분 바꾸기·지각 기록 취소(`current` = 지금 분).
   * `arrivedAtMs`는 미리 채움(화면에서만 — 등원 시각 − 첫 수업 시작)용.
   */
  | { kind: "late"; isLate: boolean; current: number | null; arrivedAtMs: number | null }
  /** 2-J: 이미 선택된 출석·결석을 다시 누름 → 취소 확인 창 */
  | { kind: "cancel_class"; status: ClassStatus }
  /** 2-J: "등원 HH:mm ✕"·"미등원 ✕" → 등원 취소 확인 창(선생님 화면) */
  | { kind: "cancel_arrival"; arrival: NonNullable<TodayArrival> }
  /** 3-B 오늘 하원 */
  | { kind: "depart" }
  /** 3-B "하원 HH:mm ✕" → 하원 취소 확인 창 */
  | { kind: "cancel_departure"; arrival: NonNullable<TodayArrival> };

const chipBtn =
  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50";

function hhmm(ms: number | null): string | null {
  return ms === null ? null : formatSeoulHHmm(new Date(ms));
}

/**
 * 반 원생 한 줄의 출석·지각·결석 버튼(2-I, 3-B 지각) — 반 상세 시트·선생님 내 반·원장 출결 화면 공용.
 * 조건(결정 3-1)이 맞지 않으면 버튼을 옅게 + 누를 수 없게 + 짧은 이유. 블러는 쓰지 않는다.
 * `allowArrive`(선생님 화면)면 등원 전·미등원 학생은 그 자리에 "등원 처리"(★5).
 * 2-J: 이미 선택된 버튼을 다시 누르면 취소(★8 — 이 반을 구독 중이면 막힌 이유와 상관없이 선택된 버튼은 누를 수 있음),
 * `allowArrive`면 "등원 HH:mm ✕"·"미등원 ✕"로 등원 기록 취소.
 * 3-A: `mode="past"`(지난 날짜 정정)는 재원·종강·그날 수업을 보지 않고 그날 등원 상태만 본다(A4).
 * 3-B: [지각]은 언제나 지각 창(분 입력·바꾸기·취소), 휴강이면 이유 "휴강", 삭제된 반은 "삭제된 반",
 * `allowDepart`(원장 오늘·선생님 화면)면 둘째 줄 "등원 15:12 ✕ [하원]" / "하원 18:05 ✕".
 */
export function ClassAttendanceControls({
  mode = "today",
  studentActive,
  classEnded,
  classDeleted = false,
  classCancelled = false,
  hasLessonToday,
  arrival,
  record,
  lateMinutes = null,
  stateError,
  allowArrive,
  allowDepart = false,
  busy,
  disabled,
  onAction,
}: {
  /** today = 오늘 기록 조건 전부, past = 지난 날짜 정정(그날 등원 상태만) */
  mode?: "today" | "past";
  studentActive: boolean;
  classEnded: boolean;
  /** 3-B 반 문서가 지워진 반(기록만 남음) — 이유 "삭제된 반" */
  classDeleted?: boolean;
  /** 3-B 그날 휴강 — undefined = 읽는 중 */
  classCancelled?: boolean | undefined;
  hasLessonToday: boolean;
  /** undefined = 읽는 중 */
  arrival: TodayArrival | undefined;
  record: ClassStatus | undefined;
  /** 지각 분(지각 기록만) */
  lateMinutes?: number | null;
  /** 구독 오류 — 버튼 옅게 */
  stateError: boolean;
  allowArrive: boolean;
  /** 3-B 하원 버튼(오늘만) */
  allowDepart?: boolean;
  /** 이 줄이 처리 중 */
  busy: RowBusy;
  /** 다른 줄이 처리 중 */
  disabled: boolean;
  onAction: (action: ClassAttendanceAction) => void;
}) {
  // 지난 날짜는 재원·종강·그날 수업을 보지 않는다(정정은 원장 판단) — 휴강은 지난 날짜도 막는다(★12)
  const cond = mode === "past"
    ? { studentActive: true, classEnded: false, hasLessonToday: true }
    : { studentActive, classEnded, hasLessonToday };
  const cancelledLoading = classCancelled === undefined;
  const preBlock = classAttendanceBlock({
    ...cond,
    isMember: true,
    arrival: { status: "present", billed: false },
    classCancelled: classCancelled === true,
  });
  const loading = !preBlock && !stateError && (arrival === undefined || cancelledLoading);
  const rawBlock =
    preBlock ??
    (arrival === undefined
      ? null
      : classAttendanceBlock({ ...cond, isMember: true, arrival, classCancelled: classCancelled === true }));
  // 삭제된 반: 오늘은 "종강" 대신, 지난 날짜는 기록이 없는 줄만(남은 기록은 고칠 수 있음)
  const deletedBlock = classDeleted && (mode === "today" || record === undefined);
  const block = deletedBlock ? "deleted" : rawBlock;
  const blockLabel = block === "deleted"
    ? "삭제된 반"
    : block
      ? mode === "past" && block === "not_arrived"
        ? "등원 기록 없음"
        : CLASS_ATTENDANCE_BLOCK_LABELS[block]
      : null;
  const reason = stateError && !preBlock ? "확인 불가" : blockLabel ?? (loading ? "확인 중" : null);

  const rowLocked = disabled || busy !== null;

  if (allowArrive && !stateError && !deletedBlock && (block === "not_arrived" || block === "absent_today")) {
    return (
      <div className="flex shrink-0 items-center gap-1.5">
        {block === "absent_today" && arrival ? (
          <button
            type="button"
            disabled={rowLocked}
            onClick={() => onAction({ kind: "cancel_arrival", arrival })}
            className={`${chipBtn} bg-neutral-500/15 text-neutral-700`}
            aria-label="미등원 기록 취소"
          >
            미등원 ✕
          </button>
        ) : null}
        <button
          type="button"
          disabled={disabled || busy !== null}
          onClick={() => onAction({ kind: "arrive" })}
          className={`${baseBtn} border-[#222] bg-[#222] text-white disabled:opacity-50`}
        >
          {busy === "arrive" ? "기록 중…" : "등원 처리"}
        </button>
      </div>
    );
  }

  const blocked = Boolean(block) || loading || (stateError && !preBlock);
  const present = !stateError && arrival && arrival.status === "present" ? arrival : null;
  const arrivedText = present ? (hhmm(present.arrivedAtMs) ? `등원 ${hhmm(present.arrivedAtMs)}` : "등원") : null;
  const leftText = present?.departed ? (hhmm(present.leftAtMs) ? `하원 ${hhmm(present.leftAtMs)}` : "하원") : null;
  const departOn = allowDepart && mode === "today" && present !== null;

  // ★8 화면: 구독 중인 반의 기록이면(구독 오류가 아닐 때) 막힌 이유와 상관없이 선택된 버튼으로 취소
  const statusButton = (status: ClassStatus) => {
    const selected = record === status;
    const cancellable = selected && !stateError;
    const faded = blocked && !cancellable;
    const label =
      status === "late" && selected && typeof lateMinutes === "number" ? `지각 ${lateMinutes}분` : CLASS_STATUS_LABELS[status];
    const onClick = () => {
      if (status === "late") {
        onAction({
          kind: "late",
          isLate: selected,
          current: selected ? lateMinutes : null,
          arrivedAtMs: arrival?.status === "present" ? arrival.arrivedAtMs : null,
        });
      }
      else onAction(cancellable ? { kind: "cancel_class", status } : { kind: "class", status });
    };
    return (
      <button
        type="button"
        aria-pressed={selected}
        title={
          status === "late"
            ? selected ? "지각 시간 바꾸기·지각 기록 취소" : undefined
            : cancellable ? `다시 누르면 ${label} 기록 취소` : undefined
        }
        disabled={faded || rowLocked}
        onClick={onClick}
        className={faded ? fadedBtn : `${STATUS_STYLE[status](selected)} disabled:opacity-50`}
      >
        {busy === status ? "기록 중…" : busy === "cancel" && selected ? "취소 중…" : label}
      </button>
    );
  };

  const departControls = departOn && present ? (
    present.departed ? (
      <button
        type="button"
        disabled={rowLocked}
        onClick={() => onAction({ kind: "cancel_departure", arrival: present })}
        className={`${chipBtn} -mr-1.5 font-normal text-sky-800`}
        aria-label={`${leftText} 기록 취소`}
      >
        {busy === "cancel_depart" ? "취소 중…" : `${leftText} ✕`}
      </button>
    ) : (
      <button
        type="button"
        disabled={rowLocked}
        onClick={() => onAction({ kind: "depart" })}
        className="rounded-[6px] border border-sky-500/50 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-900 disabled:opacity-50"
      >
        {busy === "depart" ? "기록 중…" : "하원"}
      </button>
    )
  ) : null;

  let secondLine: ReactNode = null;
  if (reason) {
    secondLine = (
      <span className="flex items-center gap-1.5">
        <span className="text-[10px] text-neutral-500">{reason}</span>
        {departControls}
      </span>
    );
  } else if (present && allowArrive && !present.departed) {
    secondLine = (
      <span className="flex items-center gap-1">
        <button
          type="button"
          disabled={rowLocked}
          onClick={() => onAction({ kind: "cancel_arrival", arrival: present })}
          className={`${chipBtn} font-normal text-neutral-500`}
          aria-label={`${arrivedText} 기록 취소`}
        >
          {busy === "cancel" && record === undefined ? "취소 중…" : `${arrivedText} ✕`}
        </button>
        {departControls}
      </span>
    );
  } else if (present && departOn) {
    secondLine = departControls;
  } else if (present) {
    secondLine = <span className="text-[10px] text-neutral-400">{leftText ?? arrivedText}</span>;
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5">
      <div className="flex gap-1">
        {statusButton("present")}
        {statusButton("late")}
        {statusButton("absent")}
      </div>
      {secondLine}
    </div>
  );
}
