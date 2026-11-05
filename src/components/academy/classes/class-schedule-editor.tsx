"use client";

import {
  draftPerDayDiffers,
  scheduleDraftError,
  setDraftPerDay,
  toggleDraftWeekday,
  WEEKDAYS,
  WEEKDAY_LABELS,
  type ScheduleDraft,
  type TimeRange,
} from "@/lib/academy/class-schedule";

const timeInputClass =
  "min-w-0 flex-1 rounded-xl border border-neutral-300/60 bg-white/60 px-3 py-2 text-sm text-foreground outline-none focus:border-[#4a90e2]/50 disabled:opacity-60";

function TimeRow({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: TimeRange;
  disabled: boolean;
  onChange: (next: TimeRange) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 shrink-0 text-xs font-medium text-neutral-600">{label}</span>
      <input
        type="time"
        step={300}
        value={value.start}
        disabled={disabled}
        onChange={(e) => onChange({ ...value, start: e.target.value })}
        className={timeInputClass}
        aria-label={`${label} 시작`}
      />
      <span className="text-xs text-neutral-500">~</span>
      <input
        type="time"
        step={300}
        value={value.end}
        disabled={disabled}
        onChange={(e) => onChange({ ...value, end: e.target.value })}
        className={timeInputClass}
        aria-label={`${label} 끝`}
      />
    </div>
  );
}

/**
 * 수업 시간 편집(2-I) — 한 반은 요일당 1칸. 요일 칩을 고르고 시간 하나(기본),
 * "요일마다 다름"을 켜면 고른 요일마다 시간 줄. 하루에 두 번 수업하면 반을 따로 만든다.
 * 막는 조건(서버와 같음)은 부모가 `scheduleDraftError`로 다시 검사하고, 여기서는 바로 보여 준다.
 */
export function ClassScheduleEditor({
  draft,
  onChangeAction,
  disabled = false,
}: {
  draft: ScheduleDraft;
  onChangeAction: (next: ScheduleDraft) => void;
  disabled?: boolean;
}) {
  const days = [...draft.weekdays].sort((a, b) => a - b);
  const blocking = days.length > 0 ? scheduleDraftError(draft) : null;
  const willMerge = draft.perDay && days.length > 1 && draftPerDayDiffers(draft);

  return (
    <div className="space-y-2 rounded-2xl border border-neutral-200/80 bg-white/40 p-3">
      <div className="flex gap-1" role="group" aria-label="수업 요일">
        {WEEKDAYS.map((d) => {
          const on = draft.weekdays.includes(d);
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => onChangeAction(toggleDraftWeekday(draft, d))}
              className={`h-9 flex-1 rounded-xl border text-xs font-medium transition ${
                on ? "border-[#222] bg-[#222] text-white" : "border-neutral-300/70 bg-white/60 text-neutral-700"
              }`}
            >
              {WEEKDAY_LABELS[d]}
            </button>
          );
        })}
      </div>

      {days.length === 0 ? (
        <p className="py-2 text-center text-xs text-neutral-500">수업 요일을 고르면 시간을 정할 수 있습니다.</p>
      ) : draft.perDay ? (
        <div className="space-y-2">
          {days.map((d) => (
            <TimeRow
              key={d}
              label={WEEKDAY_LABELS[d]!}
              value={draft.byDay[d] ?? draft.common}
              disabled={disabled}
              onChange={(next) => onChangeAction({ ...draft, byDay: { ...draft.byDay, [d]: next } })}
            />
          ))}
        </div>
      ) : (
        <TimeRow
          label="시간"
          value={draft.common}
          disabled={disabled}
          onChange={(next) => onChangeAction({ ...draft, common: next })}
        />
      )}

      {days.length > 0 ? (
        <label className="flex items-center gap-2 text-xs text-neutral-700">
          <input
            type="checkbox"
            checked={draft.perDay}
            disabled={disabled}
            onChange={(e) => onChangeAction(setDraftPerDay(draft, e.target.checked))}
            className="h-4 w-4 accent-[#222]"
          />
          요일마다 다름
        </label>
      ) : null}
      {willMerge ? (
        <p className="break-keep text-[11px] text-neutral-500">
          체크를 끄면 모든 요일이 {WEEKDAY_LABELS[days[0]!]}요일 시간으로 맞춰집니다.
        </p>
      ) : null}
      <p className="break-keep text-[11px] text-neutral-400">
        한 반은 요일마다 수업 시간이 하나입니다. 하루에 두 번 수업하면 반을 따로 만들어 주세요.
      </p>
      {blocking ? (
        <p className="break-keep text-xs text-red-700" role="alert">
          {blocking}
        </p>
      ) : null}
    </div>
  );
}
