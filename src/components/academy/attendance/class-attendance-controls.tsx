"use client";

import {
  classAttendanceBlock,
  CLASS_ATTENDANCE_BLOCK_LABELS,
  formatSeoulHHmm,
  type AttendanceStatus,
} from "@/lib/academy/attendance-rules";
import type { TodayArrival } from "@/lib/academy/use-class-today-attendance";

const baseBtn = "rounded-[8px] border px-2.5 py-1.5 text-[11px] font-medium transition disabled:cursor-not-allowed";
const presentBtn = (selected: boolean) =>
  `${baseBtn} ${
    selected
      ? "border-emerald-600 bg-emerald-600 text-white"
      : "border-emerald-400/60 bg-emerald-500/15 text-emerald-950 hover:bg-emerald-500/25"
  }`;
const absentBtn = (selected: boolean) =>
  `${baseBtn} ${
    selected
      ? "border-amber-600 bg-amber-600 text-white"
      : "border-amber-400/60 bg-amber-500/12 text-amber-950 hover:bg-amber-500/22"
  }`;
const fadedBtn = `${baseBtn} border-neutral-300/60 bg-neutral-100/60 text-neutral-400`;

export type ClassAttendanceAction =
  | { kind: "class"; status: AttendanceStatus }
  | { kind: "arrive" };

/**
 * 반 원생 한 줄의 출석·결석 버튼(2-I) — 반 상세 시트·선생님 내 반 공용.
 * 조건(결정 3-1)이 맞지 않으면 버튼을 옅게 + 누를 수 없게 + 짧은 이유. 블러는 쓰지 않는다.
 * `allowArrive`(선생님 화면)면 등원 전·미등원 학생은 그 자리에 "등원 처리"(★5).
 */
export function ClassAttendanceControls({
  studentActive,
  classEnded,
  hasLessonToday,
  arrival,
  record,
  stateError,
  allowArrive,
  busy,
  disabled,
  onAction,
}: {
  studentActive: boolean;
  classEnded: boolean;
  hasLessonToday: boolean;
  /** undefined = 읽는 중 */
  arrival: TodayArrival | undefined;
  record: AttendanceStatus | undefined;
  /** 구독 오류 — 버튼 옅게 */
  stateError: boolean;
  allowArrive: boolean;
  /** 이 줄이 처리 중 */
  busy: "present" | "absent" | "arrive" | null;
  /** 다른 줄이 처리 중 */
  disabled: boolean;
  onAction: (action: ClassAttendanceAction) => void;
}) {
  const preBlock = classAttendanceBlock({
    studentActive,
    isMember: true,
    classEnded,
    hasLessonToday,
    arrival: { status: "present", billed: false },
  });
  const loading = !preBlock && !stateError && arrival === undefined;
  const block = preBlock ?? (arrival === undefined ? null : classAttendanceBlock({
    studentActive, isMember: true, classEnded, hasLessonToday, arrival,
  }));
  const reason = stateError && !preBlock ? "확인 불가" : block ? CLASS_ATTENDANCE_BLOCK_LABELS[block] : loading ? "확인 중" : null;

  if (allowArrive && !stateError && (block === "not_arrived" || block === "absent_today")) {
    return (
      <div className="flex shrink-0 items-center gap-1.5">
        {block === "absent_today" ? (
          <span className="rounded-full bg-neutral-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-700">
            미등원
          </span>
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
  const arrivedLabel =
    !blocked && arrival && arrival.arrivedAtMs ? `등원 ${formatSeoulHHmm(new Date(arrival.arrivedAtMs))}` : null;
  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5">
      <div className="flex gap-1.5">
        <button
          type="button"
          aria-pressed={record === "present"}
          disabled={blocked || disabled || busy !== null}
          onClick={() => onAction({ kind: "class", status: "present" })}
          className={blocked ? fadedBtn : `${presentBtn(record === "present")} disabled:opacity-50`}
        >
          {busy === "present" ? "기록 중…" : "출석"}
        </button>
        <button
          type="button"
          aria-pressed={record === "absent"}
          disabled={blocked || disabled || busy !== null}
          onClick={() => onAction({ kind: "class", status: "absent" })}
          className={blocked ? fadedBtn : `${absentBtn(record === "absent")} disabled:opacity-50`}
        >
          {busy === "absent" ? "기록 중…" : "결석"}
        </button>
      </div>
      {reason ? (
        <span className="text-[10px] text-neutral-500">{reason}</span>
      ) : arrivedLabel ? (
        <span className="text-[10px] text-neutral-400">{arrivedLabel}</span>
      ) : null}
    </div>
  );
}
